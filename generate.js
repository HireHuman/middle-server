// ─── MIDDLE Story Generator — 3-Agent Pipeline ───────────────────────────────
// Agent 1: Scout — finds real stories via NewsAPI top headlines + RSS
// Agent 2: Writer — writes full editorial content for each story
// Agent 3: Verifier — fixes fact check sides and verdicts
// Image: NewsAPI image per story
// ─────────────────────────────────────────────────────────────────────────────

const GROK_API_KEY = process.env.GROK_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const FB_PROJECT   = process.env.FB_PROJECT || "themiddle-85852";
const FB_API_KEY   = process.env.FB_API_KEY  || "AIzaSyBxAzJ0bVpOb2hux5OIylBngUDr0ZoH-w4";
const FB_BASE      = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

// ─── Firestore helpers ────────────────────────────────────────────────────────
async function fsSet(path, obj) {
  const res = await fetch(`${FB_BASE}/${path}?key=${FB_API_KEY}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: encodeFields(obj) }),
  });
  if (!res.ok) throw new Error(`Firestore write failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function encodeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    else if (typeof v === "string")  out[k] = { stringValue: v };
    else if (typeof v === "number")  out[k] = { integerValue: String(Math.round(v)) };
    else if (typeof v === "boolean") out[k] = { booleanValue: v };
    else if (Array.isArray(v))       out[k] = { arrayValue: { values: v.map(encodeValue) } };
    else if (typeof v === "object")  out[k] = { mapValue: { fields: encodeFields(v) } };
  }
  return out;
}

function encodeValue(v) {
  if (typeof v === "string")  return { stringValue: v };
  if (typeof v === "number")  return { integerValue: String(Math.round(v)) };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Array.isArray(v))       return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object" && v !== null) return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}

// ─── JSON parser with aggressive sanitization ─────────────────────────────────
function parseJSON(text) {
  const arrStart = text.indexOf("[");
  const objStart = text.indexOf("{");
  let start = -1, end = -1;

  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    start = arrStart; end = text.lastIndexOf("]") + 1;
  } else if (objStart !== -1) {
    start = objStart; end = text.lastIndexOf("}") + 1;
  }
  if (start === -1 || end === 0) throw new Error("No JSON found in response");

  let raw = text.slice(start, end)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  // Walk char by char — escape raw newlines/tabs inside strings
  let cleaned = "";
  let inStr = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { cleaned += ch; escaped = false; continue; }
    if (ch === "\\") { cleaned += ch; escaped = true; continue; }
    if (ch === '"') { inStr = !inStr; cleaned += ch; continue; }
    if (inStr) {
      if (ch === "\n") { cleaned += "\\n"; continue; }
      if (ch === "\r") { cleaned += "\\r"; continue; }
      if (ch === "\t") { cleaned += "\\t"; continue; }
    }
    cleaned += ch;
  }

  cleaned = cleaned
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/}(\s*){/g, '},$1{');

  try { return JSON.parse(cleaned); } catch(e1) {
    try {
      const stripped = cleaned.replace(/[^\x20-\x7E\x09\x0A\x0D]/g, " ")
        .replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(stripped);
    } catch(e2) {
      const matches = cleaned.match(/\{[^{}]{20,}\}/gs) || [];
      if (matches.length > 0) {
        const items = matches.map(m => { try { return JSON.parse(m); } catch(e) { return null; } }).filter(Boolean);
        if (items.length > 0) { console.log("  JSON recovered " + items.length + " items"); return items; }
      }
      throw new Error("JSON parse failed: " + e1.message);
    }
  }
}

// ─── Grok API call ────────────────────────────────────────────────────────────
async function callGrok(systemPrompt, userPrompt, maxTokens = 16000) {
  const { default: https } = await import('https');
  const body = JSON.stringify({
    model: "grok-3",
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt   },
    ]
  });

  const result = await new Promise((resolve, reject) => {
    const options = {
      hostname: "api.x.ai",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROK_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    let data = "";
    const req = https.request(options, res => {
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(600000, () => { req.destroy(); reject(new Error("Grok timeout after 10 min")); });
    req.write(body);
    req.end();
  });

  if (result.status === 429) throw new Error("Grok rate limit — credits exhausted or too many requests");
  if (result.status !== 200) throw new Error(`Grok API ${result.status}: ${result.body.slice(0,300)}`);
  const parsed = JSON.parse(result.body);
  return parsed.choices?.[0]?.message?.content || "";
}

// ─── URL validator ────────────────────────────────────────────────────────────
async function validateUrl(url) {
  if (!url || !url.startsWith('http')) return false;
  try {
    const { default: https } = await import('https');
    const { default: http }  = await import('http');
    const lib = url.startsWith('https') ? https : http;
    return await new Promise((resolve) => {
      const req = lib.request(url, {
        method: 'HEAD', timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MIDDLE-NewsApp/1.0)' }
      }, (res) => { resolve(res.statusCode < 400); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  } catch(e) { return false; }
}

async function validateCoverage(newsCoverage) {
  if (!newsCoverage) return { left:[], centre:[], right:[] };
  async function validateList(list) {
    if (!Array.isArray(list)) return [];
    const results = await Promise.all(list.map(async (item) => {
      if (!item?.url) return null;
      const valid = await validateUrl(item.url);
      console.log("  " + (valid ? "VALID" : "INVALID") + ": " + item.outlet + " -- " + (item.url||"").slice(0,70));
      return valid ? item : null;
    }));
    return results.filter(Boolean);
  }
  return {
    left:   await validateList(newsCoverage.left),
    centre: await validateList(newsCoverage.centre),
    right:  await validateList(newsCoverage.right),
  };
}

// ─── NewsAPI headline fetcher ─────────────────────────────────────────────────
// Uses the /top-headlines endpoint which works on free tier
// and sources that actually allow NewsAPI access
async function fetchTodaysHeadlines() {
  if (!NEWS_API_KEY) { console.log("  No NEWS_API_KEY set"); return []; }

  const headlines = [];

  // Use top-headlines with country=us and category=general/politics
  // This endpoint works reliably on free tier
  const endpoints = [
    `https://newsapi.org/v2/top-headlines?country=us&category=general&pageSize=30&apiKey=${NEWS_API_KEY}`,
    `https://newsapi.org/v2/top-headlines?country=us&category=politics&pageSize=20&apiKey=${NEWS_API_KEY}`,
    `https://newsapi.org/v2/everything?q=congress+OR+senate+OR+president+OR+supreme+court&sortBy=publishedAt&pageSize=30&language=en&from=${new Date(Date.now()-86400000).toISOString().slice(0,10)}&apiKey=${NEWS_API_KEY}`,
  ];

  for (const url of endpoints) {
    try {
      await new Promise(r => setTimeout(r, 500));
      const res = await fetch(url);
      if (!res.ok) { console.log("  NewsAPI endpoint failed: " + res.status); continue; }
      const data = await res.json();
      const articles = (data.articles||[]).filter(a =>
        a.title && a.url &&
        !a.title.includes("[Removed]") &&
        a.source?.name !== "Removed"
      );
      console.log("  NewsAPI: " + articles.length + " headlines from " + url.slice(0,60) + "...");
      for (const a of articles) {
        headlines.push({
          title: a.title,
          url: a.url,
          source: a.source?.name || "Unknown",
          publishedAt: a.publishedAt,
          description: a.description || "",
        });
      }
    } catch(e) { console.warn("  NewsAPI fetch error: " + e.message); }
  }

  // Deduplicate by title similarity
  const seen = new Set();
  const unique = headlines.filter(h => {
    const key = h.title.slice(0,40).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log("Total unique headlines: " + unique.length);
  return unique;
}

// ─── Image fetcher ────────────────────────────────────────────────────────────
async function fetchNewsImage(searchQuery) {
  if (!NEWS_API_KEY) return { imageUrl:null, imageCredit:null, imageArticleUrl:null };
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(searchQuery)}&sortBy=relevancy&pageSize=10&language=en&apiKey=${NEWS_API_KEY}`;
    console.log("  NewsAPI image: " + searchQuery.slice(0,50));
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      console.log("  NewsAPI articles: " + (data.articles?.length||0));
      const a = (data.articles||[]).find(a =>
        a.urlToImage &&
        !a.urlToImage.includes("placeholder") &&
        !a.urlToImage.includes("none") &&
        a.urlToImage.startsWith("http")
      );
      if (a) return { imageUrl: a.urlToImage, imageCredit: a.source?.name||"News", imageArticleUrl: a.url };
    }
  } catch(e) { console.warn("  Image fetch error: " + e.message); }

  // Wikipedia fallback
  try {
    const terms = searchQuery.split(" ").slice(0,3).join("_");
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(terms)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.thumbnail?.source) return {
        imageUrl: data.thumbnail.source,
        imageCredit: "Wikipedia",
        imageArticleUrl: data.content_urls?.desktop?.page||""
      };
    }
  } catch(e) {}

  return { imageUrl:null, imageCredit:null, imageArticleUrl:null };
}

// ─── AGENT 1: STORY SCOUT + WRITER ───────────────────────────────────────────
// Receives real headlines, selects the most important stories,
// writes full editorial content
async function agentWriter(batch, headlines, excludeTopics=[]) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday:"long", month:"long", day:"numeric", year:"numeric"
  });
  const batchInstr = batch === 1
    ? "Select the TOP 5 most politically significant stories."
    : "Select the NEXT 5 most politically significant stories. Do NOT repeat any story from batch 1. " +
      (excludeTopics.length > 0 ? "Stories already covered (do NOT select these): " + excludeTopics.join("; ") : "");

  console.log("\nAgent 1 (Writer) — batch " + batch + "...");
  const start = Date.now();

  // Format headlines for context
  const headlineText = headlines.length > 0
    ? "Here are today's real news headlines to choose from:\n\n" +
      headlines.slice(0, 60).map((h,i) =>
        `${i+1}. "${h.title}" — ${h.source} (${h.url})`
      ).join("\n")
    : "No pre-fetched headlines available. Use your live web search to find today's top US political stories from the last 24 hours.";

  const system = `You are the lead editorial writer for MIDDLE, a nonpartisan news app. You have live web access.
Today is ${today}.
Your job: select and write full editorial content for 5 major US political stories from TODAY.
IMPORTANT: Focus on stories from the last 24 hours. Use real events, real names, real facts.
Return ONLY a raw JSON array. No markdown. No code fences. Start with [ end with ].
Properly escape all strings. No raw newlines inside strings. No trailing commas.`;

  const user = `${batchInstr}

${headlineText}

For each selected story, write complete editorial content. Return exactly 5 stories as a JSON array:
[{
  "id": "unique-kebab-slug-no-spaces",
  "topic": "Specific compelling headline — real names and stakes",
  "time": "Xh ago",
  "category": "POLITICS",
  "categoryColor": "#818cf8",
  "breaking": false,
  "searchQuery": "3-5 keywords for this story",
  "sourceUrl": "real URL from headlines above if available",
  "neutralSummary": "3-4 factual sentences with specific names, numbers, dates.",
  "neutralDetail": "6-8 sentences of deep background. What led to this. Who is involved. What happens next.",
  "leftSummary": "3-4 sentences making the STRONGEST honest progressive argument about this story.",
  "rightSummary": "3-4 sentences making the STRONGEST honest conservative argument about this story.",
  "commonGround": ["Real shared value both sides hold","Another genuine area of agreement","Third shared concern","Fourth overlap","Fifth common ground"],
  "conclusion": "3-4 paragraphs of Bird's-Eye View editorial. Where each side has a point. Where each side goes too far. What the evidence actually shows. What a reasonable solution looks like.",
  "blindspotLeft": "1-2 sentences: what LEFT-LEANING media is ignoring or underreporting about this story.",
  "blindspotRight": "1-2 sentences: what RIGHT-LEANING media is ignoring or underreporting about this story.",
  "factChecks": [
    {"claim":"Specific claim conservatives ARE MAKING about this story RIGHT NOW","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences of specific evidence.","likes":18400},
    {"claim":"Specific claim liberals ARE MAKING about this story RIGHT NOW","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences of specific evidence.","likes":14200},
    {"claim":"Specific claim conservatives ARE MAKING about this story RIGHT NOW","side":"right","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences of specific evidence.","likes":22800},
    {"claim":"Specific claim liberals ARE MAKING about this story RIGHT NOW","side":"left","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences of specific evidence.","likes":16400},
    {"claim":"Specific claim conservatives ARE MAKING about this story RIGHT NOW","side":"right","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences of specific evidence.","likes":11200},
    {"claim":"Specific claim liberals ARE MAKING about this story RIGHT NOW","side":"left","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences of specific evidence.","likes":19800},
    {"claim":"Specific claim conservatives ARE MAKING about this story RIGHT NOW","side":"right","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences of specific evidence.","likes":13400},
    {"claim":"Specific claim liberals ARE MAKING about this story RIGHT NOW","side":"left","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences of specific evidence.","likes":9800},
    {"claim":"Specific claim conservatives ARE MAKING about this story RIGHT NOW","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences of specific evidence.","likes":21200},
    {"claim":"Specific claim liberals ARE MAKING about this story RIGHT NOW","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences of specific evidence.","likes":12800}
  ],
  "leftPosts": [],
  "rightPosts": [],
  "newsCoverage": {"left":[],"centre":[],"right":[]}
}]

Category colors: POLITICS=#818cf8 WORLD=#ef4444 ECONOMY=#10b981 JUSTICE=#f59e0b HEALTH=#06b6d4 CULTURE=#ec4899`;

  const text = await callGrok(system, user, 32000);
  const elapsed = ((Date.now()-start)/1000).toFixed(1);
  console.log("Agent 1 done in " + elapsed + "s");
  const stories = parseJSON(text);
  console.log("Agent 1: " + stories.length + " stories written");
  return stories;
}

// ─── AGENT 2: SOURCE FINDER ───────────────────────────────────────────────────
// Finds real article URLs from left/centre/right outlets for each story
async function agentSourceFinder(story) {
  console.log("  Agent 2 (Sources) for: \"" + story.topic.slice(0,55) + "\"");
  const start = Date.now();
  const today = new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });
  const year  = new Date().getFullYear();

  const system = `You are a research librarian for MIDDLE news app. You have live web search access.
Your ONLY job: find real article URLs published TODAY or YESTERDAY about a specific news story.
Rules:
- Search the web right now using your live search capability
- Only return URLs from articles published in ${year} — specifically today or yesterday if possible
- Copy URLs EXACTLY as they appear in search results — never modify or construct URLs
- If you cannot find a verified working URL from an outlet, omit it
- Return ONLY the JSON object — no commentary`;

  const user = `Today is ${today}. Search the web RIGHT NOW for news articles about:

"${story.topic}"

Search terms to use: "${story.searchQuery} ${year}" and "${story.topic}"

Find articles published TODAY or YESTERDAY from these outlets:

LEFT-LEANING: CNN (cnn.com), NPR (npr.org), The Guardian (theguardian.com), HuffPost (huffpost.com), Vox (vox.com), Politico (politico.com), The Atlantic (theatlantic.com)

CENTRE: Reuters (reuters.com), Associated Press (apnews.com), BBC (bbc.com), Axios (axios.com), The Hill (thehill.com), Bloomberg (bloomberg.com), Newsweek (newsweek.com)

RIGHT-LEANING: Fox News (foxnews.com), New York Post (nypost.com), Washington Examiner (washingtonexaminer.com), Daily Wire (dailywire.com), Breitbart (breitbart.com), National Review (nationalreview.com), Daily Caller (dailycaller.com)

For each outlet you find, verify:
1. The article was published in ${year}
2. The URL is complete and exact from your search results
3. The article is specifically about this story

Return this JSON (only include outlets where you found a real article):
{
  "left": [
    {"outlet":"CNN","url":"https://cnn.com/EXACT-URL-FROM-SEARCH-RESULTS","headline":"Exact article headline","bias":"left"}
  ],
  "centre": [
    {"outlet":"Reuters","url":"https://reuters.com/EXACT-URL","headline":"Exact headline","bias":"centre"}
  ],
  "right": [
    {"outlet":"Fox News","url":"https://foxnews.com/EXACT-URL","headline":"Exact headline","bias":"right"}
  ]
}`;

  try {
    const text = await callGrok(system, user, 8000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    console.log("    Agent 2 raw response length: " + text.length + " chars");
    console.log("    Agent 2 raw preview: " + text.slice(0,100));
    if (text.length < 10) {
      console.warn("    Agent 2 returned empty response — retrying once...");
      await new Promise(r => setTimeout(r, 3000));
      const text2 = await callGrok(system, user, 8000);
      console.log("    Agent 2 retry length: " + text2.length + " chars");
      if (text2.length < 10) return { left:[], centre:[], right:[] };
      const coverage2 = parseJSON(text2);
      const total2 = (coverage2.left?.length||0)+(coverage2.centre?.length||0)+(coverage2.right?.length||0);
      console.log("    Agent 2 retry: " + total2 + " sources found");
      return coverage2;
    }
    const coverage = parseJSON(text);
    const total = (coverage.left?.length||0)+(coverage.centre?.length||0)+(coverage.right?.length||0);
    console.log("    Agent 2 done in " + elapsed + "s — " + total + " sources found");
    return coverage;
  } catch(e) {
    console.warn("    Agent 2 failed: " + e.message);
    return { left:[], centre:[], right:[] };
  }
}

// ─── AGENT 3: VERIFIER ────────────────────────────────────────────────────────
// Checks fact check accuracy and fixes side assignments
async function agentVerifier(story) {
  console.log("  Agent 3 (Verifier) for: \"" + story.topic.slice(0,55) + "\"");
  const start = Date.now();

  const system = `You are a senior fact-checker for MIDDLE, a nonpartisan news app. You have live web access.
Your job: review a story's fact checks and fix any errors in side assignment or verdicts.
CRITICAL: The only valid values for "side" are "left" or "right". Never use "neutral", "both", or any other value.
- side="right" means conservatives/Republicans are making this claim
- side="left" means liberals/Democrats are making this claim
Return ONLY a raw JSON object. No markdown. No commentary.`;

  const fcList = (story.factChecks||[])
    .map((fc,i) => `${i}. [${fc.side}] "${fc.claim}" — ${fc.verdict}`)
    .join('\n');

  const user = `Review these fact checks for the story: "${story.topic}"

${fcList}

For each fact check answer:
1. Is the "side" correct? A RIGHT claim must be something conservatives are actually saying. A LEFT claim must be something liberals are actually saying.
2. Is the verdict (TRUE/FALSE/MISLEADING/UNVERIFIED) accurate based on evidence?

Return this JSON:
{
  "approved": true,
  "corrections": [
    {"index": 0, "field": "side", "newValue": "left", "reason": "This claim is being made by liberals not conservatives"},
    {"index": 2, "field": "verdict", "newValue": "MISLEADING", "reason": "The claim is partially true but missing context"}
  ],
  "notes": "Overall assessment"
}

If everything is correct return approved: true and empty corrections array.
Only flag genuine errors.`;

  try {
    const text = await callGrok(system, user, 3000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    console.log("    Agent 3 done in " + elapsed + "s — approved: " + review.approved);

    const corrections = Array.isArray(review.corrections) ? review.corrections : [];
    for (const fix of corrections) {
      if (typeof fix.index === 'number' && fix.index >= 0 && fix.index < (story.factChecks||[]).length) {
        const oldVal = story.factChecks[fix.index][fix.field];
        // Reject invalid side values — only left/right allowed
        if (fix.field === "side" && !["left","right"].includes(fix.newValue)) {
          console.log("    SKIPPED invalid side value: " + fix.newValue);
          continue;
        }
        story.factChecks[fix.index][fix.field] = fix.newValue;
        console.log("    Fixed factCheck[" + fix.index + "] " + fix.field + ": " + oldVal + " → " + fix.newValue);
      }
    }
    story.verifierNotes = review.notes || "";
    return story;
  } catch(e) {
    console.warn("    Agent 3 failed: " + e.message);
    return story;
  }
}

// ─── FULL PIPELINE ────────────────────────────────────────────────────────────
async function processBatch(batchNum, headlines, excludeTopics=[]) {
  const stories = await agentWriter(batchNum, headlines, excludeTopics);
  const processed = [];

  for (let i = 0; i < stories.length; i++) {
    let story = stories[i];
    console.log("\nProcessing story " + (i+1) + "/" + stories.length + ": \"" + story.topic.slice(0,55) + "\"");

    // Agent 2: Find sources
    story.newsCoverage = await agentSourceFinder(story);
    await new Promise(r => setTimeout(r, 1500));

    // Agent 3: Verify and fix
    story = await agentVerifier(story);
    await new Promise(r => setTimeout(r, 1000));

    // Validate URLs
    if (story.newsCoverage) {
      story.newsCoverage = await validateCoverage(story.newsCoverage);
    }

    // Image
    const delay = i * 3500;
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    const queries = [story.searchQuery, story.topic.split(" ").slice(0,4).join(" ")].filter(Boolean);
    let image = { imageUrl:null, imageCredit:null, imageArticleUrl:null };
    for (const q of queries) {
      image = await fetchNewsImage(q).catch(() => ({ imageUrl:null, imageCredit:null, imageArticleUrl:null }));
      if (image.imageUrl) { console.log("  Image found"); break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    story.imageUrl        = image.imageUrl;
    story.imageCredit     = image.imageCredit;
    story.imageArticleUrl = image.imageArticleUrl;

    const c = story.newsCoverage||{};
    const srcCount = (c.left?.length||0)+(c.centre?.length||0)+(c.right?.length||0);
    console.log("  Done — " + srcCount + " verified sources, image: " + (story.imageUrl?"yes":"no"));
    processed.push(story);
  }
  return processed;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== MIDDLE Story Generator -- 3-Agent Pipeline ===");
  console.log("Started at: " + new Date().toISOString());
  if (!GROK_API_KEY) throw new Error("GROK_API_KEY not set");

  const today = new Date().toISOString().slice(0,10);
  console.log("Date: " + today);

  // Fetch real headlines first
  console.log("\nFetching today's headlines...");
  const headlines = await fetchTodaysHeadlines();
  console.log("Headlines ready: " + headlines.length + "\n");

  // Batch 1
  console.log("=== BATCH 1 ===");
  const batch1 = await processBatch(1, headlines);
  await fsSet("storyCache/" + today, {
    storiesJson: JSON.stringify(batch1),
    generatedAt: new Date().toISOString(),
    complete: false,
  });
  console.log("\nBatch 1 saved — " + batch1.length + " stories");

  // Batch 2 — exclude batch 1 topics to prevent duplicates
  const batch1Topics = batch1.map(s => s.topic);
  console.log("\n=== BATCH 2 ===");
  const batch2 = await processBatch(2, headlines, batch1Topics);

  const all = [...batch1, ...batch2];
  await fsSet("storyCache/" + today, {
    storiesJson: JSON.stringify(all),
    generatedAt: new Date().toISOString(),
    complete: true,
  });

  const totalSrc = all.reduce((s,x) => {
    const c = x.newsCoverage||{};
    return s+(c.left?.length||0)+(c.centre?.length||0)+(c.right?.length||0);
  }, 0);

  console.log("\n=== DONE ===");
  console.log(all.length + " stories saved for " + today);
  console.log(totalSrc + " verified news sources total");
  console.log(all.filter(s=>s.imageUrl).length + "/10 stories with images");
  console.log("Finished: " + new Date().toISOString());
}

main().catch(err => {
  console.error("FAILED:", err.message || err);
  process.exit(0);
});
