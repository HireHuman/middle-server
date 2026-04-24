// ─── MIDDLE Story Generator ───────────────────────────────────────────────────
const GROK_API_KEY = process.env.GROK_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const FB_PROJECT   = process.env.FB_PROJECT || "themiddle-85852";
const FB_API_KEY   = process.env.FB_API_KEY  || "AIzaSyBxAzJ0bVpOb2hux5OIylBngUDr0ZoH-w4";
const FB_BASE      = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

// ─── Firestore ────────────────────────────────────────────────────────────────
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

// ─── Reddit ───────────────────────────────────────────────────────────────────
const LEFT_SUBS  = ["politics","news","worldnews","progressive","democrats","Liberal","uspolitics","PoliticalDiscussion"];
const RIGHT_SUBS = ["conservative","Republican","AskConservatives","Libertarian","PoliticsRight","republicans","TGIF_Republican"];

const REDDIT_HEADERS = { "User-Agent": "MIDDLE-NewsApp/1.0" };

// Relevance check — at least 1 keyword from search query appears in title
// Much more lenient than before
function isRelevant(title, searchQuery) {
  if (!title) return false;
  const t = title.toLowerCase();
  // Try each word 4+ chars long
  const keywords = searchQuery.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
  if (keywords.length === 0) return true; // no keywords to check, accept all
  return keywords.some(kw => t.includes(kw));
}

async function fetchOneSub(sub, query) {
  try {
    // Try relevance sort first — best for specific topics
    const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=month&limit=15&restrict_sr=1`;
    const res = await fetch(url, { headers: REDDIT_HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.data?.children || [])
      .map(c => c.data)
      .filter(p => p && p.title && p.score >= 1); // very low threshold
  } catch(e) {
    return [];
  }
}

async function fetchSidePosts(searchQuery, topic, subs, side) {
  // Fetch all subs in parallel
  const results = await Promise.all(subs.map(s => fetchOneSub(s, searchQuery)));
  const allPosts = results.flat();

  console.log(`  Reddit ${side}: ${allPosts.length} raw posts from ${subs.length} subs`);

  // Deduplicate
  const seen = new Set();
  const unique = allPosts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  // Apply relevance filter — but fall back to all posts if filter is too strict
  let relevant = unique.filter(p => isRelevant(p.title, searchQuery));
  console.log(`  Reddit ${side}: ${relevant.length} relevant after filter`);

  // If filter removed too many, use all unique posts instead
  if (relevant.length < 3) {
    console.log(`  Reddit ${side}: too few relevant, using all ${unique.length} unique posts`);
    relevant = unique;
  }

  // Sort by score descending
  relevant.sort((a,b) => b.score - a.score);

  // Format top 5
  const formatted = relevant.slice(0, 5).map((p, i) => ({
    id: `${side[0]}${i+1}`,
    handle: `r/${p.subreddit}`,
    source: "Reddit",
    avatar: p.subreddit[0].toUpperCase(),
    text: p.title,
    likes: p.score,
    reposts: p.num_comments,
    url: `https://reddit.com${p.permalink}`,
    searchQuery,
    thread: p.selftext?.length > 30
      ? [{ avatar:"R", handle:`u/${p.author}`, text:p.selftext.slice(0,300), likes:Math.floor(p.score*0.2) }]
      : []
  }));

  // Only pad if genuinely no posts found at all
  const fallbackSub = side === "left" ? "politics" : "conservative";
  while (formatted.length < 5) {
    const i = formatted.length;
    formatted.push({
      id: `${side[0]}${i+1}`,
      handle: `r/${fallbackSub}`,
      source: "Reddit",
      avatar: fallbackSub[0].toUpperCase(),
      text: `View Reddit discussion: ${searchQuery}`,
      likes: 0, reposts: 0,
      url: `https://www.reddit.com/r/${fallbackSub}/search/?q=${encodeURIComponent(searchQuery)}&sort=relevance&t=month`,
      searchQuery, thread: []
    });
  }

  console.log(`  Reddit ${side} final: ${formatted.filter(p=>p.likes>0).length} real, ${formatted.filter(p=>p.likes===0).length} fallback`);
  return formatted;
}

async function fetchRedditPosts(searchQuery, topic) {
  console.log(`  Reddit fetching: "${searchQuery}"`);
  const [leftPosts, rightPosts] = await Promise.all([
    fetchSidePosts(searchQuery, topic, LEFT_SUBS,  "left"),
    fetchSidePosts(searchQuery, topic, RIGHT_SUBS, "right"),
  ]);
  return { leftPosts, rightPosts };
}

// ─── Image ────────────────────────────────────────────────────────────────────
async function fetchNewsImage(searchQuery) {
  if (NEWS_API_KEY) {
    try {
      const res = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(searchQuery)}&sortBy=relevancy&pageSize=5&language=en&apiKey=${NEWS_API_KEY}`
      );
      if (res.ok) {
        const data = await res.json();
        const a = (data.articles||[]).find(a => a.urlToImage && !a.urlToImage.includes("placeholder"));
        if (a) return { imageUrl: a.urlToImage, imageCredit: a.source?.name||"News", imageArticleUrl: a.url };
      }
    } catch(e) {}
  }
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
  return { imageUrl: null, imageCredit: null, imageArticleUrl: null };
}

// ─── Grok ─────────────────────────────────────────────────────────────────────
function buildPrompt(batch) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday:"long", month:"long", day:"numeric", year:"numeric"
  });
  const batchInstr = batch === 1
    ? "Focus on the TOP 5 most-discussed political stories right now."
    : "Focus on the NEXT 5 most-discussed political stories. Do NOT repeat batch 1 stories.";

  return `You are the lead editorial writer for "The Middle" — a nonpartisan news app. Today is ${today}.

Search the web for 5 major political stories RIGHT NOW. ${batchInstr}

Return ONLY a raw JSON array. No markdown. Start with [ end with ].

Include "searchQuery": 3-5 specific keywords for Reddit search (names, bill names, key terms).

JSON shape:
[{
  "id":"kebab-slug",
  "topic":"Specific headline with names",
  "time":"Xh ago",
  "category":"POLITICS",
  "categoryColor":"#818cf8",
  "breaking":false,
  "searchQuery":"specific search terms",
  "neutralSummary":"3-4 factual sentences.",
  "neutralDetail":"6-8 sentences background.",
  "leftSummary":"3-4 sentences progressive argument.",
  "rightSummary":"3-4 sentences conservative argument.",
  "commonGround":["value1","value2","value3","value4","value5"],
  "conclusion":"3-4 paragraph Birds Eye View editorial.",
  "factChecks":[
    {"claim":"Right claim","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences.","likes":18400},
    {"claim":"Left claim","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences.","likes":14200},
    {"claim":"Right claim","side":"right","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences.","likes":22800},
    {"claim":"Left claim","side":"left","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences.","likes":16400},
    {"claim":"Right claim","side":"right","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences.","likes":11200},
    {"claim":"Left claim","side":"left","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences.","likes":19800},
    {"claim":"Right claim","side":"right","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences.","likes":13400},
    {"claim":"Left claim","side":"left","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences.","likes":9800},
    {"claim":"Right claim","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences.","likes":21200},
    {"claim":"Left claim","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences.","likes":12800}
  ],
  "leftPosts":[],
  "rightPosts":[]
}]

Category colors: POLITICS=#818cf8 WORLD=#ef4444 ECONOMY=#10b981 JUSTICE=#f59e0b HEALTH=#06b6d4 CULTURE=#ec4899
Generate exactly 5 stories.`;
}

async function fetchBatch(batchNum) {
  console.log(`\nCalling Grok batch ${batchNum}...`);
  const start = Date.now();

  // Use undici/node fetch with no timeout — let Grok take as long as it needs
  const { default: https } = await import('https');

  const result = await new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "grok-3",
      max_tokens: 32000,
      messages: [
        { role:"system", content:"You are editorial AI for MIDDLE. You have live web access. CRITICAL: Respond with a raw JSON array ONLY. No markdown, no code fences, no commentary. Start immediately with [ and end with ]. Ensure all strings are properly escaped. Never use unescaped newlines, tabs, or quotes inside string values. Every object must have all required fields. Validate your JSON is complete before responding." },
        { role:"user", content:buildPrompt(batchNum) }
      ]
    });

    const options = {
      hostname: "api.x.ai",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROK_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 600000, // 10 minutes
    };

    let data = "";
    const req = https.request(options, res => {
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.setTimeout(600000);
    req.write(body);
    req.end();
  });

  if (result.status !== 200) throw new Error(`Grok API ${result.status}: ${result.body}`);

  const parsed = JSON.parse(result.body);
  const text = parsed.choices?.[0]?.message?.content || "";
  const elapsed = ((Date.now()-start)/1000).toFixed(1);
  console.log(`Batch ${batchNum} received in ${elapsed}s (${text.length} chars)`);

  const si = text.indexOf("[");
  const ei = text.lastIndexOf("]")+1;
  if (si === -1 || ei === 0) throw new Error("No JSON array in response");

  let raw = text.slice(si, ei);

  // Aggressive sanitization — remove all control chars that break JSON
  raw = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  // Fix unescaped newlines/tabs inside JSON strings
  // Walk char by char and clean inside string values
  let cleaned = "";
  let inStr = false;
  let escaped = false;
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

  let stories;

  function repairJSON(str) {
    // Fix common Grok JSON issues
    let s = str;

    // Remove trailing commas before } or ]
    s = s.replace(/,(\s*[}\]])/g, '$1');

    // Fix missing commas between } and { (missing comma between array objects)
    s = s.replace(/}(\s*){/g, '},$1{');

    // Fix missing commas between ] and [ 
    s = s.replace(/](\s*)\[/g, '],$1[');

    // Fix unescaped quotes inside strings (basic heuristic)
    // Replace smart quotes with regular quotes
    s = s.replace(/[‘’]/g, "'");
    s = s.replace(/[“”]/g, '\"');

    // Remove any remaining control chars
    s = s.replace(/[ --]/g, '');

    return s;
  }

  // Attempt 1: parse cleaned string
  try {
    stories = JSON.parse(cleaned);
  } catch(e1) {
    console.log("  Parse attempt 1 failed, trying repair...");

    // Attempt 2: repair then parse
    try {
      stories = JSON.parse(repairJSON(cleaned));
    } catch(e2) {
      console.log("  Parse attempt 2 failed, trying aggressive strip...");

      // Attempt 3: extract just the array, strip everything aggressive
      try {
        const aggressive = cleaned
          .replace(/[^\x20-\x7E]/g, ' ')  // strip all non-ASCII
          .replace(/,(\s*[}\]])/g, '$1')      // remove trailing commas
          .replace(/}(\s*){/g, '},$1{');      // add missing commas
        stories = JSON.parse(aggressive);
      } catch(e3) {
        // Attempt 4: try to parse story by story and skip broken ones
        try {
          const matches = cleaned.match(/\{[^{}]*"id"[^{}]*\}/gs) || [];
          if (matches.length > 0) {
            stories = matches.map(m => {
              try { return JSON.parse(repairJSON(m)); } catch(e) { return null; }
            }).filter(Boolean);
            if (stories.length === 0) throw new Error("No valid stories found");
            console.log(`  Recovered ${stories.length} stories individually`);
          } else {
            throw new Error("No story objects found");
          }
        } catch(e4) {
          throw new Error("JSON parse failed after all attempts: " + e1.message);
        }
      }
    }
  }
  console.log(`Batch ${batchNum}: ${stories.length} stories OK`);
  return stories;
}

async function enrichStory(story, imageDelay=0) {
  console.log(`\nEnriching: "${story.topic}"`);
  const query = story.searchQuery || story.topic;

  // Fetch Reddit immediately, stagger image requests to avoid rate limits
  const [reddit] = await Promise.allSettled([
    fetchRedditPosts(query, story.topic),
  ]);

  // Stagger image fetch to avoid NewsAPI rate limit
  if (imageDelay > 0) await new Promise(r => setTimeout(r, imageDelay));
  const image = await fetchNewsImage(query).catch(e => ({ imageUrl:null, imageCredit:null, imageArticleUrl:null }));

  story.leftPosts       = reddit.status==="fulfilled" ? reddit.value.leftPosts  : [];
  story.rightPosts      = reddit.status==="fulfilled" ? reddit.value.rightPosts : [];
  story.imageUrl        = image.imageUrl        || null;
  story.imageCredit     = image.imageCredit     || null;
  story.imageArticleUrl = image.imageArticleUrl || null;

  return story;
}

async function main() {
  console.log("=== MIDDLE Story Generator ===");
  console.log(`Started at: ${new Date().toISOString()}`);
  if (!GROK_API_KEY) throw new Error("GROK_API_KEY not set");

  const today = new Date().toISOString().slice(0,10);
  console.log(`Date: ${today}`);

  // Batch 1
  const raw1 = await fetchBatch(1);
  const batch1 = [];
  for (let i = 0; i < raw1.length; i++) {
    batch1.push(await enrichStory(raw1[i], i * 1200));
    await new Promise(r => setTimeout(r, 1500));
  }

  await fsSet(`storyCache/${today}`, {
    storiesJson: JSON.stringify(batch1),
    generatedAt: new Date().toISOString(),
    complete: false,
  });
  console.log("Batch 1 saved to Firestore.");

  // Batch 2
  const raw2 = await fetchBatch(2);
  const batch2 = [];
  for (let i = 0; i < raw2.length; i++) {
    batch2.push(await enrichStory(raw2[i], i * 1200));
    await new Promise(r => setTimeout(r, 1500));
  }

  const all = [...batch1, ...batch2];
  await fsSet(`storyCache/${today}`, {
    storiesJson: JSON.stringify(all),
    generatedAt: new Date().toISOString(),
    complete: true,
  });

  console.log(`\n✅ Done! ${all.length} stories for ${today}`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
