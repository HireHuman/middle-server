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

// ─── Grok API call (Chat Completions — no web search) ────────────────────────
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
    req.setTimeout(1200000, () => { req.destroy(); reject(new Error("Grok timeout after 20 min")); });
    req.write(body);
    req.end();
  });

  if (result.status === 429) throw new Error("Grok rate limit — credits exhausted or too many requests");
  if (result.status !== 200) throw new Error(`Grok API ${result.status}: ${result.body.slice(0,300)}`);
  const parsed = JSON.parse(result.body);
  return parsed.choices?.[0]?.message?.content || "";
}

// ─── URL validator ────────────────────────────────────────────────────────────
// Outlets that block HEAD requests but are valid news sources
const TRUSTED_DOMAINS = [
  "washingtonpost.com", "nytimes.com", "wsj.com", "ft.com",
  "theatlantic.com", "newyorker.com", "economist.com",
  "bloomberg.com", "businessinsider.com",
  "axios.com", "politico.com", "thehill.com",
  "foxnews.com", "dailywire.com", "nationalreview.com",
  "breitbart.com", "dailycaller.com", "newsmax.com",
  "washingtonexaminer.com", "nypost.com"
];

async function validateUrl(url) {
  if (!url || !url.startsWith('http')) return false;

  // Skip validation for trusted paywalled outlets — they block HEAD requests
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    if (TRUSTED_DOMAINS.some(d => hostname.includes(d))) {
      console.log("  TRUSTED (skipping validation): " + hostname);
      return true;
    }
  } catch(e) {}

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
  if (!NEWS_API_KEY) { console.log("  No NEWS_API_KEY"); return { left:[], centre:[], right:[] }; }

  const from = new Date(Date.now() - 86400000).toISOString().slice(0,10);
  const pageSize = 30;

  const LEFT_DOMAINS   = "npr.org,theguardian.com,huffpost.com,politico.com,vox.com,theatlantic.com,salon.com,thenation.com,motherjones.com,slate.com,newrepublic.com,rawstory.com,talkingpointsmemo.com,theintercept.com";
  const CENTRE_DOMAINS = "reuters.com,apnews.com,bbc.com,axios.com,thehill.com,bloomberg.com,cbsnews.com,nbcnews.com";
  const RIGHT_DOMAINS  = "foxnews.com,breitbart.com,washingtonexaminer.com,dailywire.com,nationalreview.com,nypost.com,newsmax.com,dailycaller.com";

  async function fetchByDomains(domains, side) {
    try {
      const url = `https://newsapi.org/v2/everything?domains=${domains}&from=${from}&sortBy=publishedAt&pageSize=${pageSize}&language=en&apiKey=${NEWS_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.articles||[])
        .filter(a => a.title && a.url && !a.title.includes("[Removed]"))
        .map(a => ({ title:a.title, url:a.url, source:a.source?.name||"Unknown",
                     publishedAt:a.publishedAt, description:a.description||"", lean:side }));
    } catch(e) { return []; }
  }

  async function fetchTopHeadlines(category, side) {
    try {
      const url = `https://newsapi.org/v2/top-headlines?country=us&category=${category}&pageSize=${pageSize}&apiKey=${NEWS_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.articles||[])
        .filter(a => a.title && a.url && !a.title.includes("[Removed]"))
        .map(a => ({ title:a.title, url:a.url, source:a.source?.name||"Unknown",
                     publishedAt:a.publishedAt, description:a.description||"", lean:side }));
    } catch(e) { return []; }
  }

  // Fetch in parallel — use top-headlines for general pool + domain-specific for balance
  const [
    leftDomains, centreDomains, rightDomains,
    topGeneral, topPolitics
  ] = await Promise.all([
    fetchByDomains(LEFT_DOMAINS,   "left"),
    fetchByDomains(CENTRE_DOMAINS, "centre"),
    fetchByDomains(RIGHT_DOMAINS,  "right"),
    fetchTopHeadlines("general",  "centre"),
    fetchTopHeadlines("politics", "centre"),
  ]);

  // Classify top-headlines by known outlet bias
  const LEFT_OUTLET_NAMES   = new Set(["NPR","The Guardian","HuffPost","Politico","Vox",
    "The Atlantic","Salon","The Nation","Mother Jones","Slate","The New Republic",
    "Raw Story","Talking Points Memo","The Intercept","MSNBC","CNN"]);
  const RIGHT_OUTLET_NAMES  = new Set(["Fox News","Breitbart","Washington Examiner",
    "Daily Wire","National Review","Daily Caller","New York Post","Newsmax",
    "The Blaze","Townhall","The Federalist"]);

  const extraLeft = [], extraRight = [], extraCentre = [];
  for (const a of [...topGeneral, ...topPolitics]) {
    const name = a.source || "";
    if (LEFT_OUTLET_NAMES.has(name))       extraLeft.push({...a, lean:"left"});
    else if (RIGHT_OUTLET_NAMES.has(name)) extraRight.push({...a, lean:"right"});
    else                                   extraCentre.push({...a, lean:"centre"});
  }

  const leftArticles   = [...leftDomains,   ...extraLeft];
  const centreArticles = [...centreDomains, ...extraCentre];
  const rightArticles  = [...rightDomains,  ...extraRight];

  console.log(`  Raw: ${leftArticles.length}L ${centreArticles.length}C ${rightArticles.length}R`);

  // Deduplicate within each side by title
  function dedupe(articles) {
    const seen = new Set();
    return articles.filter(a => {
      const key = a.title.slice(0,40).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const left   = dedupe(leftArticles);
  const centre = dedupe(centreArticles);
  const right  = dedupe(rightArticles);

  console.log(`  Headlines: ${left.length}L ${centre.length}C ${right.length}R`);
  return { left, centre, right };
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

// ─── AGENT 1A: STORY SELECTOR ────────────────────────────────────────────────
async function agentSelector(batch, headlines, excludeTopics=[]) {
  console.log("\nAgent 1A (Selector) — batch " + batch + "...");
  const start = Date.now();

  function scoreCoverage(h, otherArr) {
    const kws = h.title.toLowerCase().split(/\s+/).filter(w=>w.length>4);
    return (otherArr||[]).filter(o=>kws.some(kw=>o.title.toLowerCase().includes(kw))).length;
  }

  const leftScored  = (headlines.left||[]).map(h=>({...h,score:scoreCoverage(h,headlines.right||[])})).sort((a,b)=>b.score-a.score);
  const rightScored = (headlines.right||[]).map(h=>({...h,score:scoreCoverage(h,headlines.left||[])})).sort((a,b)=>b.score-a.score);
  const centreTop   = (headlines.centre||[]).slice(0,10);
  const fmt = arr => arr.slice(0,10).map((h,i)=>`${i+1}. [${h.source}${h.score>0?" ★":""}] "${h.title}"`).join("\n");

  const batchLabel = batch===1
    ? "Select the 5 most nationally significant political stories."
    : "Select the NEXT 5 most significant stories — different topics from: " + (excludeTopics.slice(0,5).join(", ")||"none");

  const system = `You are a senior news editor for MIDDLE, a nonpartisan app. Select 5 stories based purely on national significance and cross-partisan coverage. Return ONLY a raw JSON array.`;

  const user = `${batchLabel}

Headlines (★ = covered by BOTH left and right — highest priority):

LEFT:
${fmt(leftScored)}

CENTRE:
${fmt(centreTop)}

RIGHT:
${fmt(rightScored)}

Rules: Prioritise ★ stories. National significance only. Max 1 story per topic area. Neutral framing. No celebrity/sports/memes/lifestyle.

Return exactly 5:
[{"topic":"Neutral headline","searchQuery":"3-5 keywords","category":"POLITICS","categoryColor":"#818cf8","breaking":false}]
Category colors: POLITICS=#818cf8 WORLD=#ef4444 ECONOMY=#10b981 JUSTICE=#f59e0b HEALTH=#06b6d4 CULTURE=#ec4899`;

  const text = await callGrok(system, user, 2000);
  const elapsed = ((Date.now()-start)/1000).toFixed(1);
  const selected = parseJSON(text);
  const valid = (Array.isArray(selected)?selected:[selected]).filter(s=>s&&s.topic).slice(0,5);
  console.log("Agent 1A done in " + elapsed + "s — " + valid.length + " topics selected");
  return valid;
}

// ─── AGENT 1A-REVIEW: EDITORIAL DIRECTOR ─────────────────────────────────────
async function agentSelectorReview(selected, headlines, batch) {
  console.log("Agent 1A-Review (Editorial Director)...");
  const start = Date.now();

  const allHeadlines = [...(headlines.left||[]),...(headlines.centre||[]),...(headlines.right||[])];
  const headlineTitles = allHeadlines.slice(0,30).map(h=>`[${h.source}] "${h.title}"`).join("\n");

  const system = `You are the Editorial Director of MIDDLE, a nonpartisan news app. You have final say on story selection. Review and approve or correct the proposed story list. Return ONLY a raw JSON object.`;

  const proposed = selected.map((s,i)=>`${i+1}. "${s.topic}" [${s.category}]`).join("\n");

  const user = `Review these proposed stories for batch ${batch}:

${proposed}

Available headlines for reference:
${headlineTitles}

MIDDLE IS A POLITICAL NEWS APP. All 5 stories must be political. Do NOT replace political stories with health, environment, science, lifestyle, or entertainment topics under any circumstances.

Check ONLY for these specific problems:
1. NOT NATIONAL: Is this clearly only a local or state-level issue with no national implications? (replace if yes)
2. INVENTED: Does this story NOT appear in any of the reference headlines? (replace if yes)
3. DUPLICATE TOPIC: Are 3 or more stories about the exact same event? (replace duplicates if yes)
4. LOADED FRAMING: Does the headline use partisan language that clearly favors one side? (fix framing only — do not replace the story)

DO NOT replace stories for these wrong reasons:
- "Too many Trump stories" — Trump IS the news, cover him fairly
- "Too many politics stories" — this is a politics app
- "Lacks diversity" — political diversity means different political TOPICS, not different subjects
- "Better to cover health/environment" — NO, MIDDLE covers politics only

Valid replacement topics must be: major legislation, Supreme Court decisions, elections, foreign policy, economy/trade, national security, major political appointments or scandals.

Return:
{
  "approved": true,
  "corrections": [
    {
      "index": 2,
      "action": "replace",
      "reason": "Story does not appear in any reference headlines — likely invented",
      "newTopic": "Topic from the reference headlines above",
      "newSearchQuery": "keywords from headline",
      "newCategory": "POLITICS",
      "newCategoryColor": "#818cf8"
    }
  ],
  "directorNote": "Brief honest assessment"
}

If all stories are legitimate political news, return approved: true with empty corrections. Be conservative — only replace when there is a clear specific problem.`;

  try {
    const text = await callGrok(system, user, 3000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    console.log("Agent 1A-Review done in " + elapsed + "s — approved: " + review.approved);
    if (review.directorNote) console.log("  Director: " + review.directorNote);

    // Apply corrections
    const corrections = Array.isArray(review.corrections) ? review.corrections : [];
    for (const fix of corrections) {
      if (typeof fix.index==="number" && fix.index>=0 && fix.index<selected.length && fix.action==="replace") {
        console.log("  Replacing story " + fix.index + ": " + fix.reason);
        selected[fix.index] = {
          topic: fix.newTopic,
          searchQuery: fix.newSearchQuery,
          category: fix.newCategory || "POLITICS",
          categoryColor: fix.newCategoryColor || "#818cf8",
          breaking: false
        };
      }
    }
    return selected;
  } catch(e) {
    console.warn("  1A-Review failed: " + e.message + " — using original selection");
    return selected;
  }
}

// ─── AGENT 1B: STORY WRITER ───────────────────────────────────────────────────
async function agentWriter(storyMeta) {
  const today = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});

  const system = `You are the lead editorial writer for MIDDLE, a nonpartisan news app. Write one complete, deeply researched political story. Return ONLY a raw JSON object. No markdown. No code fences. Properly escape all strings.`;

  const user = `Today is ${today}. Write a complete MIDDLE story about:
"${storyMeta.topic}" (search: "${storyMeta.searchQuery}")

Return a single JSON object:
{
  "id": "kebab-slug",
  "topic": "${storyMeta.topic}",
  "time": "Xh ago",
  "category": "${storyMeta.category||"POLITICS"}",
  "categoryColor": "${storyMeta.categoryColor||"#818cf8"}",
  "breaking": false,
  "searchQuery": "${storyMeta.searchQuery}",
  "sourceUrl": "",
  "neutralSummary": "3-4 factual sentences. Real names, numbers, dates.",
  "neutralDetail": "6-8 sentences of deep background and context.",
  "leftSummary": "3-4 sentences — strongest honest progressive argument.",
  "rightSummary": "3-4 sentences — strongest honest conservative argument.",
  "commonGround": ["Shared value 1","Shared value 2","Shared value 3","Shared value 4","Shared value 5"],
  "conclusion": "3-4 paragraphs Bird's-Eye View editorial. Where each side has a point. Where each overreaches. What evidence shows.",
  "blindspotLeft": "What left-leaning media is ignoring about this story.",
  "blindspotRight": "What right-leaning media is ignoring about this story.",
  "factChecks": [
    {"claim":"Specific claim conservatives ARE making","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences evidence.","likes":18400},
    {"claim":"Specific claim liberals ARE making","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences evidence.","likes":14200},
    {"claim":"Specific claim conservatives ARE making","side":"right","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences evidence.","likes":22800},
    {"claim":"Specific claim liberals ARE making","side":"left","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences evidence.","likes":16400},
    {"claim":"Specific claim conservatives ARE making","side":"right","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences evidence.","likes":11200},
    {"claim":"Specific claim liberals ARE making","side":"left","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences evidence.","likes":19800},
    {"claim":"Specific claim conservatives ARE making","side":"right","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences evidence.","likes":13400},
    {"claim":"Specific claim liberals ARE making","side":"left","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences evidence.","likes":9800},
    {"claim":"Specific claim conservatives ARE making","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences evidence.","likes":21200},
    {"claim":"Specific claim liberals ARE making","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences evidence.","likes":12800}
  ],
  "leftPosts": [],
  "rightPosts": [],
  "newsCoverage": {"left":[],"centre":[],"right":[]}
}`;

  let text = "";
  for (let attempt=0; attempt<2; attempt++) {
    try { text = await callGrok(system, user, 8000); break; }
    catch(e) {
      if (attempt<1) { console.warn("  Writer retry..."); await new Promise(r=>setTimeout(r,3000)); }
      else throw e;
    }
  }
  const story = parseJSON(text);
  if (!story||!story.topic) throw new Error("Writer returned invalid story");
  return story;
}

// ─── AGENT 1B-REVIEW: SENIOR EDITOR ──────────────────────────────────────────
async function agentWriterReview(story) {
  console.log("  Agent 1B-Review (Senior Editor)...");
  const start = Date.now();

  const system = `You are the Senior Editor of MIDDLE, a nonpartisan news app. Review a written story for balance, accuracy and quality. Return ONLY a raw JSON object.`;

  const user = `Review this story for editorial balance: "${story.topic}"

Left summary: "${(story.leftSummary||"").slice(0,300)}"
Right summary: "${(story.rightSummary||"").slice(0,300)}"

ONLY check these two things:
1. Is leftSummary genuinely the strongest honest progressive argument? (not a strawman)
2. Is rightSummary genuinely the strongest honest conservative argument? (not a strawman)

Return ONLY:
{
  "approved": true,
  "corrections": {
    "leftSummary": null,
    "rightSummary": null
  },
  "editorNote": "One sentence assessment"
}

Set corrections to null if summaries are strong. Only provide replacement text if a summary is genuinely a strawman. Do NOT invent new fields. Do NOT check facts — that is Agent 3's job.`;

  try {
    const text = await callGrok(system, user, 3000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    console.log("    1B-Review done in " + elapsed + "s — approved: " + review.approved);
    if (review.editorNote) console.log("    Editor: " + review.editorNote);

    const c = review.corrections || {};
    // Only apply corrections to known valid story fields
    if (c.leftSummary  && typeof c.leftSummary  === "string" && c.leftSummary.length  > 50) {
      story.leftSummary  = c.leftSummary;  console.log("    Fixed: leftSummary");
    }
    if (c.rightSummary && typeof c.rightSummary === "string" && c.rightSummary.length > 50) {
      story.rightSummary = c.rightSummary; console.log("    Fixed: rightSummary");
    }
    return story;
  } catch(e) {
    console.warn("    1B-Review failed: " + e.message + " — using original");
    return story;
  }
}

// ─── AGENT 2: SOURCE FINDER ───────────────────────────────────────────────────
const OUTLET_BIAS_MAP = {
  "cnn":"left","msnbc":"left","nytimes":"left","washingtonpost":"left",
  "theguardian":"left","guardian":"left","npr":"left","huffpost":"left",
  "huffingtonpost":"left","vox":"left","theatlantic":"left","atlantic":"left",
  "politico":"left","slate":"left","salon":"left","motherjones":"left",
  "thenation":"left","newrepublic":"left","rawstory":"left","theintercept":"left",
  "talkingpointsmemo":"left",
  "reuters":"centre","apnews":"centre","bbc":"centre","axios":"centre",
  "thehill":"centre","bloomberg":"centre","newsweek":"centre","time":"centre",
  "usatoday":"centre","cbsnews":"centre","abcnews":"centre","nbcnews":"centre",
  "pbs":"centre","pbsnewshour":"centre",
  "foxnews":"right","nypost":"right","wsj":"right","washingtonexaminer":"right",
  "dailywire":"right","breitbart":"right","nationalreview":"right",
  "dailycaller":"right","newsmax":"right","washingtontimes":"right",
  "thefederalist":"right","townhall":"right","theblaze":"right",
};

const OUTLET_NAME_MAP = {
  "cnn.com":"CNN","msnbc.com":"MSNBC","nytimes.com":"New York Times",
  "washingtonpost.com":"Washington Post","theguardian.com":"The Guardian",
  "npr.org":"NPR","huffpost.com":"HuffPost","vox.com":"Vox",
  "theatlantic.com":"The Atlantic","politico.com":"Politico",
  "slate.com":"Slate","salon.com":"Salon","motherjones.com":"Mother Jones",
  "thenation.com":"The Nation","newrepublic.com":"New Republic",
  "rawstory.com":"Raw Story","theintercept.com":"The Intercept",
  "reuters.com":"Reuters","apnews.com":"Associated Press","bbc.com":"BBC",
  "bbc.co.uk":"BBC","axios.com":"Axios","thehill.com":"The Hill",
  "bloomberg.com":"Bloomberg","newsweek.com":"Newsweek","time.com":"Time",
  "usatoday.com":"USA Today","cbsnews.com":"CBS News",
  "abcnews.go.com":"ABC News","nbcnews.com":"NBC News",
  "foxnews.com":"Fox News","nypost.com":"New York Post",
  "wsj.com":"Wall Street Journal","washingtonexaminer.com":"Washington Examiner",
  "dailywire.com":"Daily Wire","breitbart.com":"Breitbart",
  "nationalreview.com":"National Review","dailycaller.com":"Daily Caller",
  "newsmax.com":"Newsmax",
};

function getOutletBiasFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace("www.","");
    const domain = hostname.split(".")[0].toLowerCase();
    return OUTLET_BIAS_MAP[domain] ||
           OUTLET_BIAS_MAP[hostname.replace(".com","").replace(".org","").replace(".net","")] ||
           null;
  } catch(e) { return null; }
}

function getOutletNameFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace("www.","");
    return OUTLET_NAME_MAP[hostname] ||
           hostname.replace(".com","").replace(".org","").replace(".net","");
  } catch(e) { return "Unknown"; }
}

async function agentSourceFinder(story, allHeadlines, globalUsedUrls=new Set()) {
  console.log("  Agent 2 (Sources) for: \"" + story.topic.slice(0,55) + "\"");
  const start = Date.now();

  const keywords = (story.searchQuery||story.topic).toLowerCase()
    .split(/\s+/).filter(w=>w.length>3);

  const allList = [
    ...(allHeadlines.left||[]),
    ...(allHeadlines.centre||[]),
    ...(allHeadlines.right||[]),
  ];

  // Pre-filter: article must mention at least 1 keyword in title or description
  const candidates = allList.filter(h => {
    if (globalUsedUrls.has(h.url)) return false;
    const text = ((h.title||"")+" "+(h.description||"")).toLowerCase();
    return keywords.some(kw => text.includes(kw));
  });

  // Classify by bias
  const left=[], centre=[], right=[];
  for (const article of candidates) {
    const bias = getOutletBiasFromUrl(article.url);
    if (!bias) continue;

    const headline = (article.title||"").toLowerCase();
    const isHighVolume = ["foxnews.com","nypost.com","breitbart.com","dailycaller.com"]
      .some(d=>(article.url||"").includes(d));
    const minMatches = isHighVolume ? 2 : 1;
    const matches = keywords.filter(kw=>headline.includes(kw)).length;
    if (matches < minMatches) continue;

    const item = {
      outlet: getOutletNameFromUrl(article.url),
      url: article.url,
      headline: article.title,
      bias
    };
    if (bias==="left")   left.push(item);
    if (bias==="centre") centre.push(item);
    if (bias==="right")  right.push(item);
  }

  const result = {
    left:   left.slice(0,5),
    centre: centre.slice(0,5),
    right:  right.slice(0,5),
  };
  const total = result.left.length+result.centre.length+result.right.length;
  console.log("    Agent 2 done in " + ((Date.now()-start)/1000).toFixed(1) + "s — " +
    total + " sources (" + result.left.length + "L " + result.centre.length + "C " + result.right.length + "R)");
  return result;
}

// ─── AGENT 2-REVIEW: SOURCE EDITOR ───────────────────────────────────────────
async function agentSourceReview(story, coverage) {
  console.log("  Agent 2-Review (Source Editor)...");
  const start = Date.now();

  const allSources = [
    ...(coverage.left||[]).map((s,i)=>({...s, idx:"L"+i})),
    ...(coverage.centre||[]).map((s,i)=>({...s, idx:"C"+i})),
    ...(coverage.right||[]).map((s,i)=>({...s, idx:"R"+i})),
  ];

  if (allSources.length === 0) {
    console.log("    2-Review: no sources to check");
    return coverage;
  }

  const system = `You are the Source Editor for MIDDLE news app. Review article headlines and confirm they are actually about the story topic. Return ONLY a raw JSON object.`;

  const sourceList = allSources.map(s =>
    `${s.idx}: [${s.outlet}] "${s.headline}"`
  ).join("\n");

  const user = `Story topic: "${story.topic}"

Proposed sources:
${sourceList}

For each source, confirm: is this article actually about "${story.topic}"?
An article is RELEVANT if its headline clearly covers this story or closely related aspects.
An article is IRRELEVANT if it just shares a keyword but is about something else entirely.

Return:
{
  "approved": true,
  "drop": ["L1", "R0"],
  "reviewNote": "Brief note"
}

List the idx codes of any articles to DROP. If all are relevant, return empty drop array.`;

  try {
    const text = await callGrok(system, user, 2000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    const toDrop = new Set(review.drop||[]);
    console.log("    2-Review done in " + elapsed + "s — dropping: " + (toDrop.size||"none"));
    if (review.reviewNote) console.log("    Source Editor: " + review.reviewNote);

    if (toDrop.size > 0) {
      coverage.left   = (coverage.left||[]).filter((_,i)=>!toDrop.has("L"+i));
      coverage.centre = (coverage.centre||[]).filter((_,i)=>!toDrop.has("C"+i));
      coverage.right  = (coverage.right||[]).filter((_,i)=>!toDrop.has("R"+i));
      const remaining = coverage.left.length+coverage.centre.length+coverage.right.length;
      console.log("    Sources after review: " + remaining);
    }
    return coverage;
  } catch(e) {
    console.warn("    2-Review failed: " + e.message + " — keeping all sources");
    return coverage;
  }
}

// ─── AGENT 3: FACT CHECK VERIFIER ────────────────────────────────────────────
async function agentVerifier(story) {
  console.log("  Agent 3 (Fact Checker)...");
  const start = Date.now();

  const fcList = (story.factChecks||[])
    .filter(fc=>fc&&fc.claim&&fc.side&&fc.verdict)
    .map((fc,i)=>`${i}. [${fc.side}] "${fc.claim}" — ${fc.verdict}`)
    .join("\n");

  if (!fcList) { console.log("    Agent 3: no fact checks"); return story; }

  const system = `You are the Fact Checker for MIDDLE, a nonpartisan news app. Verify fact check accuracy and side assignment. Return ONLY a raw JSON object.`;

  const user = `Story: "${story.topic}"

Fact checks to verify:
${fcList}

For each fact check:
1. SIDE: Is "right" a claim conservatives are actually making? Is "left" a claim liberals are actually making?
2. VERDICT: Is TRUE/FALSE/MISLEADING/UNVERIFIED accurate based on evidence?

Valid side values: "left" or "right" ONLY — never "neutral" or "both".

Return:
{
  "approved": true,
  "corrections": [
    {"index": 0, "field": "side", "newValue": "left", "reason": "This is a liberal claim"},
    {"index": 2, "field": "verdict", "newValue": "MISLEADING", "reason": "Partially true but missing context"}
  ],
  "checkerNote": "Overall assessment"
}`;

  try {
    const text = await callGrok(system, user, 3000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    console.log("    Agent 3 done in " + elapsed + "s — approved: " + review.approved);
    if (review.checkerNote) console.log("    Checker: " + review.checkerNote);

    for (const fix of (review.corrections||[])) {
      if (typeof fix.index!=="number"||fix.index<0||fix.index>=(story.factChecks||[]).length) continue;
      if (fix.field==="side"&&!["left","right"].includes(fix.newValue)) {
        console.log("    SKIPPED invalid side: " + fix.newValue); continue;
      }
      const old = story.factChecks[fix.index][fix.field];
      story.factChecks[fix.index][fix.field] = fix.newValue;
      console.log("    Fixed factCheck["+fix.index+"] "+fix.field+": "+old+" → "+fix.newValue);
    }
    story.verifierNotes = review.checkerNote||"";
    return story;
  } catch(e) {
    console.warn("    Agent 3 failed: " + e.message);
    return story;
  }
}

// ─── AGENT 3-REVIEW: CHIEF FACT CHECKER ──────────────────────────────────────
async function agentVerifierReview(story) {
  console.log("  Agent 3-Review (Chief Fact Checker)...");
  const start = Date.now();

  const fcList = (story.factChecks||[])
    .filter(fc=>fc&&fc.claim)
    .map((fc,i)=>`${i}. [${fc.side}] "${fc.claim}" — ${fc.verdict}: "${(fc.explanation||"").slice(0,80)}"`)
    .join("\n");

  const system = `You are the Chief Fact Checker for MIDDLE. Give a second opinion on the corrected fact checks. Ensure each claim is real, each side assignment is correct, and each verdict is accurate. Return ONLY a raw JSON object.`;

  const user = `Story: "${story.topic}"

Corrected fact checks (post Agent 3 review):
${fcList}

Second opinion check:
1. Are ALL 10 claims specific and real — not vague or invented?
2. Are ALL side assignments correct (right=conservative claim, left=liberal claim)?
3. Are ALL verdicts accurate?
4. Is there a mix of TRUE/FALSE/MISLEADING/UNVERIFIED verdicts (not all one verdict)?

Return:
{
  "approved": true,
  "finalCorrections": [
    {"index": 0, "field": "verdict", "newValue": "FALSE", "reason": "Evidence contradicts this claim"}
  ],
  "chiefNote": "Final assessment"
}`;

  try {
    const text = await callGrok(system, user, 2000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    console.log("    3-Review done in " + elapsed + "s — approved: " + review.approved);
    if (review.chiefNote) console.log("    Chief: " + review.chiefNote);

    for (const fix of (review.finalCorrections||[])) {
      if (typeof fix.index!=="number"||fix.index<0||fix.index>=(story.factChecks||[]).length) continue;
      if (fix.field==="side"&&!["left","right"].includes(fix.newValue)) continue;
      const old = story.factChecks[fix.index][fix.field];
      story.factChecks[fix.index][fix.field] = fix.newValue;
      console.log("    Chief fixed factCheck["+fix.index+"] "+fix.field+": "+old+" → "+fix.newValue);
    }
    return story;
  } catch(e) {
    console.warn("    3-Review failed: " + e.message);
    return story;
  }
}

// ─── FINAL GATE: QUALITY CONTROLLER ──────────────────────────────────────────
async function agentQualityGate(story) {
  console.log("  Final Gate (Quality Controller)...");
  const start = Date.now();

  const srcCount = (story.newsCoverage?.left?.length||0) +
                   (story.newsCoverage?.centre?.length||0) +
                   (story.newsCoverage?.right?.length||0);

  const system = `You are the Quality Controller for MIDDLE, a nonpartisan news app. You have final authority to approve or reject stories. Return ONLY a raw JSON object.`;

  const user = `Today is ${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}. Final quality check for: "${story.topic}"

Story stats:
- Sources: ${srcCount} (${story.newsCoverage?.left?.length||0}L ${story.newsCoverage?.centre?.length||0}C ${story.newsCoverage?.right?.length||0}R)
- Has image: ${story.imageUrl ? "yes" : "no"}
- Fact checks: ${(story.factChecks||[]).length}
- Has left summary: ${!!story.leftSummary}
- Has right summary: ${!!story.rightSummary}
- Has conclusion: ${!!story.conclusion}
- Has blindspots: ${!!story.blindspotLeft && !!story.blindspotRight}

Neutral summary preview: "${(story.neutralSummary||"").slice(0,200)}"
Left summary preview: "${(story.leftSummary||"").slice(0,150)}"
Right summary preview: "${(story.rightSummary||"").slice(0,150)}"

We are in the year 2026. Stories about 2026 events are current and real.

Approve if:
- Story has genuine national political significance
- Both left and right summaries are present
- At least 1 verified source exists

Reject ONLY if:
- Story is clearly celebrity, sports, or non-political lifestyle content
- Both left AND right summaries are completely missing
- Story is clearly fictional with no basis in reality (e.g. fictional characters, impossible events)

DO NOT reject for:
- Having only 1 source (sources are supplementary)
- Mentioning 2025 or 2026 dates (we are in 2026)
- Being critical of any political figure (that is normal news)
- Uncertainty about minor details

Return:
{
  "approved": true,
  "qualityScore": 8,
  "flags": [],
  "gatekeeperNote": "Brief final note"
}

qualityScore: 1-10. flags: list any specific problems even if approved.`;

  try {
    const text = await callGrok(system, user, 1500);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    console.log("    Final Gate done in " + elapsed + "s — approved: " + review.approved + " score: " + review.qualityScore + "/10");
    if (review.gatekeeperNote) console.log("    Gatekeeper: " + review.gatekeeperNote);
    if ((review.flags||[]).length > 0) console.log("    Flags: " + review.flags.join(", "));
    story.qualityScore = review.qualityScore || 5;
    story.qualityFlags = review.flags || [];
    return { story, approved: review.approved !== false };
  } catch(e) {
    console.warn("    Final Gate failed: " + e.message + " — approving by default");
    return { story, approved: true };
  }
}

// ─── FULL PIPELINE ────────────────────────────────────────────────────────────
async function processBatch(batchNum, headlines, excludeTopics=[], globalUsedUrls=new Set()) {

  // Step 1A: Select story topics
  let selected = await agentSelector(batchNum, headlines, excludeTopics);
  if (selected.length === 0) throw new Error("Agent 1A returned no topics");

  // Step 1A-Review: Editorial Director signs off on selection
  selected = await agentSelectorReview(selected, headlines, batchNum);
  console.log("\nApproved topics:");
  selected.forEach((s,i) => console.log("  " + (i+1) + ". " + s.topic));

  // Steps 1B → 1B-Review → 2 → 2-Review → 3 → 3-Review → Final Gate
  const processed = [];

  for (let i = 0; i < selected.length; i++) {
    const meta = selected[i];
    console.log("\n── Story " + (i+1) + "/" + selected.length + ": \"" + meta.topic.slice(0,55) + "\" ──");

    let story;

    // 1B: Write story
    try {
      console.log("  Agent 1B (Writer)...");
      const wStart = Date.now();
      story = await agentWriter(meta);
      console.log("  1B done in " + ((Date.now()-wStart)/1000).toFixed(1) + "s");
    } catch(e) {
      console.warn("  1B failed: " + e.message + " — skipping story");
      continue;
    }
    await new Promise(r=>setTimeout(r,1000));

    // 1B-Review: Senior Editor signs off on editorial
    story = await agentWriterReview(story);
    await new Promise(r=>setTimeout(r,1000));

    // 2: Find sources
    story.newsCoverage = await agentSourceFinder(story, headlines, globalUsedUrls);
    await new Promise(r=>setTimeout(r,500));

    // 2-Review: Source Editor signs off on sources
    story.newsCoverage = await agentSourceReview(story, story.newsCoverage);
    await new Promise(r=>setTimeout(r,500));

    // Validate URLs
    story.newsCoverage = await validateCoverage(story.newsCoverage);

    // Mark used URLs
    [...(story.newsCoverage.left||[]),...(story.newsCoverage.centre||[]),...(story.newsCoverage.right||[])]
      .forEach(item => { if (item?.url) globalUsedUrls.add(item.url); });

    await new Promise(r=>setTimeout(r,500));

    // 3: Fact checker
    story = await agentVerifier(story);
    await new Promise(r=>setTimeout(r,500));

    // 3-Review: Chief fact checker signs off
    story = await agentVerifierReview(story);
    await new Promise(r=>setTimeout(r,500));

    // Image
    const stopWords = new Set(["that","this","with","from","over","into","amid","have",
      "been","will","they","them","their","after","about","would","also","says",
      "said","just","more","than","when","what","where","some","could","should"]);
    const topicWords = story.topic.split(" ").filter(w=>w.length>3&&!stopWords.has(w.toLowerCase()));
    const imgQueries = [
      story.searchQuery,
      topicWords.slice(0,5).join(" "),
      topicWords.slice(0,4).join(" "),
      topicWords.slice(0,3).join(" "),
    ].filter((q,i,arr)=>q&&arr.indexOf(q)===i);

    let image = {imageUrl:null,imageCredit:null,imageArticleUrl:null};
    for (const q of imgQueries) {
      image = await fetchNewsImage(q).catch(()=>({imageUrl:null,imageCredit:null,imageArticleUrl:null}));
      if (image.imageUrl) { console.log("  Image found: " + q.slice(0,40)); break; }
      await new Promise(r=>setTimeout(r,800));
    }
    story.imageUrl        = image.imageUrl;
    story.imageCredit     = image.imageCredit;
    story.imageArticleUrl = image.imageArticleUrl;

    // Final Gate: Quality Controller approves for publication
    const { story: finalStory, approved } = await agentQualityGate(story);

    if (!approved) {
      console.log("  ❌ REJECTED by Quality Controller — not publishing");
      continue;
    }

    const srcCount = (finalStory.newsCoverage?.left?.length||0) +
                     (finalStory.newsCoverage?.centre?.length||0) +
                     (finalStory.newsCoverage?.right?.length||0);
    console.log("  ✅ APPROVED — " + srcCount + " sources, image: " + (finalStory.imageUrl?"yes":"no") + ", score: " + (finalStory.qualityScore||"?")+"/10");
    processed.push(finalStory);
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
  const totalHL = (headlines.left?.length||0)+(headlines.centre?.length||0)+(headlines.right?.length||0);
  console.log("Headlines ready: " + totalHL + " (" + (headlines.left?.length||0) + "L " + (headlines.centre?.length||0) + "C " + (headlines.right?.length||0) + "R)\n");

  const globalUsedUrls = new Set();
  // Batch 1
  console.log("=== BATCH 1 ===");
  const batch1 = await processBatch(1, headlines, [], globalUsedUrls);
  await fsSet("storyCache/" + today, {
    storiesJson: JSON.stringify(batch1),
    generatedAt: new Date().toISOString(),
    complete: false,
  });
  console.log("\nBatch 1 saved — " + batch1.length + " stories");

  // Batch 2 — exclude batch 1 topics to prevent duplicates
  const batch1Topics = batch1.map(s => s.topic);
  console.log("\n=== BATCH 2 ===");
  const batch2 = await processBatch(2, headlines, batch1Topics, globalUsedUrls);

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
