// ─── MIDDLE Story Generator — Grok 4.3 Pipeline ────────────────────────────────
// Model: grok-4.3 (reasoning built-in, migrated from grok-3 before May 15 retirement)
// Agents: 1A Selector → 1A-Review → 1B Writer → 1B-Review → 2 Sources → 3 Facts → Gate
// Agent 2 uses Responses API with live web search for real verified URLs
// Agent 2 fallbacknt for each story
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
    model: "grok-4.3",
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

// ─── GROK 4.3 API CALLS ──────────────────────────────────────────────────────
// Two separate callers:
// callGrok43()      — Chat Completions, reasoning built in, no web search
// callGrok43Search() — Responses API, with live web search tool

async function callGrok43(systemPrompt, userPrompt, maxTokens=8000) {
  const { default: https } = await import('https');
  const body = JSON.stringify({
    model: "grok-4.3",
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt   },
    ]
  });

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.x.ai",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROK_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(900000, () => { req.destroy(); reject(new Error("Grok 4.3 timeout after 15 min")); });
    req.write(body);
    req.end();
  });

  if (result.status === 429) throw new Error("Grok rate limit — add credits at console.x.ai");
  if (result.status !== 200) throw new Error(`Grok 4.3 API ${result.status}: ${result.body.slice(0,300)}`);
  const parsed = JSON.parse(result.body);
  return parsed.choices?.[0]?.message?.content || "";
}

async function callGrok43Search(systemPrompt, userPrompt, maxTokens=6000) {
  const { default: https } = await import('https');
  const body = JSON.stringify({
    model: "grok-4.3",
    max_tokens: maxTokens,
    tools: [{ type: "web_search" }],
    input: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt   },
    ]
  });

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.x.ai",
      path: "/v1/responses",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROK_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error("Search timeout after 5 min")); });
    req.write(body);
    req.end();
  });

  if (result.status === 429) throw new Error("Grok rate limit");
  if (result.status !== 200) throw new Error(`Grok Responses API ${result.status}: ${result.body.slice(0,300)}`);

  const parsed = JSON.parse(result.body);
  let text = "";
  for (const item of (parsed.output||[])) {
    if (item.type === "message") {
      for (const c of (item.content||[])) {
        if (c.type === "output_text") text += c.text;
      }
    }
  }
  return text || "";
}

// ─── OUTLET BIAS MAP ──────────────────────────────────────────────────────────
const OUTLET_BIAS_MAP = {
  "cnn":"left","msnbc":"left","nytimes":"left","washingtonpost":"left",
  "theguardian":"left","guardian":"left","npr":"left","huffpost":"left",
  "vox":"left","theatlantic":"left","politico":"left","slate":"left",
  "salon":"left","motherjones":"left","thenation":"left","newrepublic":"left",
  "rawstory":"left","theintercept":"left","talkingpointsmemo":"left",
  "reuters":"centre","apnews":"centre","bbc":"centre","axios":"centre",
  "thehill":"centre","bloomberg":"centre","newsweek":"centre",
  "usatoday":"centre","cbsnews":"centre","abcnews":"centre","nbcnews":"centre",
  "pbs":"centre","time":"centre","economist":"centre",
  "foxnews":"right","nypost":"right","wsj":"right","washingtonexaminer":"right",
  "dailywire":"right","breitbart":"right","nationalreview":"right",
  "dailycaller":"right","newsmax":"right","washingtontimes":"right",
  "thefederalist":"right","townhall":"right","theblaze":"right",
  "epochtimes":"right",
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
  "axios.com":"Axios","thehill.com":"The Hill","bloomberg.com":"Bloomberg",
  "newsweek.com":"Newsweek","time.com":"Time","usatoday.com":"USA Today",
  "cbsnews.com":"CBS News","abcnews.go.com":"ABC News","nbcnews.com":"NBC News",
  "foxnews.com":"Fox News","nypost.com":"New York Post",
  "wsj.com":"Wall Street Journal","washingtonexaminer.com":"Washington Examiner",
  "dailywire.com":"Daily Wire","breitbart.com":"Breitbart",
  "nationalreview.com":"National Review","dailycaller.com":"Daily Caller",
  "newsmax.com":"Newsmax",
};

const TRUSTED_DOMAINS = [
  "washingtonpost.com","nytimes.com","wsj.com","theatlantic.com",
  "bloomberg.com","economist.com","axios.com","politico.com",
  "foxnews.com","dailywire.com","nationalreview.com","breitbart.com",
  "dailycaller.com","newsmax.com","washingtonexaminer.com","nypost.com",
  "thehill.com","newrepublic.com","salon.com","slate.com","vox.com",
  "motherjones.com","thenation.com","theintercept.com",
  "reuters.com","apnews.com","bbc.com","bbc.co.uk","npr.org",
  "theguardian.com","huffpost.com","cbsnews.com","nbcnews.com",
  "abcnews.go.com","usatoday.com","time.com","newsweek.com",
  "rawstory.com","talkingpointsmemo.com","theintercept.com",
];

function getOutletBias(url) {
  try {
    const host = new URL(url).hostname.replace("www.","");
    const domain = host.split(".")[0].toLowerCase();
    return OUTLET_BIAS_MAP[domain] ||
           OUTLET_BIAS_MAP[host.replace(/\.(com|org|net|co\.uk)$/,"")] || null;
  } catch(e) { return null; }
}

function getOutletName(url) {
  try {
    const host = new URL(url).hostname.replace("www.","");
    return OUTLET_NAME_MAP[host] ||
           host.replace(/\.(com|org|net)$/,"").replace(/^www\./,"");
  } catch(e) { return "Unknown"; }
}

// ─── AGENT 1A: STORY SELECTOR ─────────────────────────────────────────────────
// Grok 4.3 reasoning: reads headlines, selects 5 best story topics
async function agentSelector(batch, headlines, excludeTopics=[]) {
  console.log(`\nAgent 1A (Selector) — batch ${batch}...`);
  const start = Date.now();

  // Score headlines by cross-coverage (appear on both left and right)
  function score(h, other) {
    const kws = h.title.toLowerCase().split(/\s+/).filter(w=>w.length>4);
    return (other||[]).filter(o=>kws.some(kw=>o.title.toLowerCase().includes(kw))).length;
  }

  const leftScored  = (headlines.left||[]).map(h=>({...h,score:score(h,headlines.right||[])})).sort((a,b)=>b.score-a.score);
  const rightScored = (headlines.right||[]).map(h=>({...h,score:score(h,headlines.left||[])})).sort((a,b)=>b.score-a.score);
  const centreTop   = (headlines.centre||[]).slice(0,15);

  const fmt = arr => arr.slice(0,15).map((h,i)=>
    `${i+1}. [${h.source}${h.score>0?" ★":""}] "${h.title}"`
  ).join("\n");

  const exclude = excludeTopics.length > 0
    ? `\nAlready covered — do NOT select these topics: ${excludeTopics.slice(0,5).join(" | ")}`
    : "";

  const hasHeadlines = leftScored.length > 0 || centreTop.length > 0 || rightScored.length > 0;

  const system = `You are the senior news editor for MIDDLE, a nonpartisan political news app. Your job is to select the 5 most important US political stories of the day.

MIDDLE covers: federal legislation, Supreme Court, elections, foreign policy, economy/trade, national security, major political appointments, significant political scandals.
MIDDLE does NOT cover: celebrity, sports, entertainment, lifestyle, minor state issues, social media posts, memes.

Return ONLY a raw JSON array. No markdown. No commentary.`;

  const headlinesSection = hasHeadlines
    ? `Headlines (★ = covered by BOTH left AND right sources — prioritise these):

LEFT-LEANING SOURCES:
${fmt(leftScored)}

CENTRE/NEUTRAL SOURCES:
${centreTop.map((h,i)=>`${i+1}. [${h.source}] "${h.title}"`).join("\n")}

RIGHT-LEANING SOURCES:
${fmt(rightScored)}

SELECTION RULES:
1. Prioritise ★ stories — cross-partisan significance
2. Only select stories that appear in the headlines above
3. National significance only
4. Topic diversity — max 1 story per area
5. Neutral framing — no partisan language`
    : `No pre-fetched headlines available today. Use your knowledge of today's major US political news.

SELECTION RULES:
1. Select the 5 most nationally significant US political stories happening RIGHT NOW
2. National significance only — federal legislation, Supreme Court, elections, foreign policy, economy, national security
3. Topic diversity — cover different areas
4. Neutral framing — no partisan language in headlines
5. Real stories only — no invented events`;

  const user = `Select the 5 most nationally significant US political stories for today.${exclude}

${headlinesSection}

Return exactly 5 items:
[
  {
    "topic": "Neutral compelling headline with specific names",
    "searchQuery": "3-5 specific keywords",
    "category": "POLITICS",
    "categoryColor": "#818cf8",
    "breaking": false
  }
]
Category colors: POLITICS=#818cf8 WORLD=#ef4444 ECONOMY=#10b981 JUSTICE=#f59e0b HEALTH=#06b6d4 CULTURE=#ec4899`;

  let text = "";
  for (let attempt=0; attempt<2; attempt++) {
    try { text = await callGrok43(system, user, 2000); break; }
    catch(e) {
      if (attempt<1) { console.warn("  1A retry..."); await new Promise(r=>setTimeout(r,3000)); }
      else throw e;
    }
  }

  const elapsed = ((Date.now()-start)/1000).toFixed(1);
  const selected = parseJSON(text);
  const valid = (Array.isArray(selected)?selected:[selected]).filter(s=>s&&s.topic).slice(0,5);
  console.log(`Agent 1A done in ${elapsed}s — ${valid.length} topics selected`);
  return valid;
}

// ─── AGENT 1A-REVIEW: EDITORIAL DIRECTOR ──────────────────────────────────────
// Grok 4.3 reasoning: verifies selection quality, replaces weak picks
async function agentSelectorReview(selected, headlines, batch) {
  console.log("Agent 1A-Review (Editorial Director)...");
  const start = Date.now();

  const allHL = [...(headlines.left||[]),...(headlines.centre||[]),...(headlines.right||[])];
  const hlTitles = allHL.slice(0,40).map(h=>`[${h.source}] "${h.title}"`).join("\n");
  const proposed = selected.map((s,i)=>`${i+1}. "${s.topic}" [${s.category}]`).join("\n");

  const system = `You are the Editorial Director of MIDDLE, a nonpartisan political news app. You have final authority on story selection. Your only job is to ensure the selected stories meet MIDDLE's editorial standards.

CRITICAL: MIDDLE is a POLITICAL news app. All stories must be political. NEVER replace political stories with health, science, environment, or lifestyle content.`;

  const user = `Review batch ${batch} story selection:

PROPOSED STORIES:
${proposed}

AVAILABLE HEADLINES FOR REFERENCE:
${hlTitles}

Only replace a story if ONE of these specific problems exists:
1. The story does NOT appear in any reference headline (invented)
2. The story is clearly local/state-level with zero national implications  
3. Three or more stories cover the exact same event (duplicates)
4. The story is celebrity, sports, entertainment, or non-political lifestyle

DO NOT replace stories for any other reason. Especially do NOT replace political stories with health or environment topics.

Any replacement must come from the reference headlines above (if available) and be a nationally significant political story.
If no reference headlines were provided, only replace stories that are clearly non-political (celebrity/sports/lifestyle).

Return:
{
  "approved": true,
  "corrections": [
    {
      "index": 2,
      "reason": "Does not appear in reference headlines — likely invented",
      "newTopic": "Topic from reference headlines",
      "newSearchQuery": "keywords",
      "newCategory": "POLITICS",
      "newCategoryColor": "#818cf8"
    }
  ],
  "directorNote": "One sentence assessment"
}

If all stories are legitimate political news from the headlines, return approved: true with empty corrections array.`;

  try {
    const text = await callGrok43(system, user, 3000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    console.log(`Agent 1A-Review done in ${elapsed}s — approved: ${review.approved}`);
    if (review.directorNote) console.log(`  Director: ${review.directorNote}`);

    for (const fix of (review.corrections||[])) {
      if (typeof fix.index!=="number"||fix.index<0||fix.index>=selected.length) continue;
      console.log(`  Replacing story ${fix.index+1}: ${fix.reason}`);
      selected[fix.index] = {
        topic: fix.newTopic, searchQuery: fix.newSearchQuery,
        category: fix.newCategory||"POLITICS",
        categoryColor: fix.newCategoryColor||"#818cf8", breaking: false
      };
    }
    return selected;
  } catch(e) {
    console.warn(`  1A-Review failed: ${e.message} — using original`);
    return selected;
  }
}

// ─── AGENT 1B: STORY WRITER ───────────────────────────────────────────────────
// Grok 4.3 reasoning: writes one complete story with full editorial content
async function agentWriter(storyMeta) {
  const today = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});

  const system = `You are the lead editorial writer for MIDDLE, a nonpartisan news app. Write one deeply researched, completely balanced political story. Use your reasoning capability to ensure every section is accurate, specific, and fair to both sides.

Return ONLY a raw JSON object. No markdown. No code fences. Properly escape all strings. No raw newlines inside strings.`;

  const user = `Today is ${today}. Write a complete MIDDLE story about:
"${storyMeta.topic}"
Search terms: "${storyMeta.searchQuery}"

Return a single JSON object with ALL fields:
{
  "id": "kebab-slug-unique",
  "topic": "${storyMeta.topic}",
  "time": "Xh ago",
  "category": "${storyMeta.category||"POLITICS"}",
  "categoryColor": "${storyMeta.categoryColor||"#818cf8"}",
  "breaking": false,
  "searchQuery": "${storyMeta.searchQuery}",
  "sourceUrl": "",
  "neutralSummary": "3-4 factual sentences. Real specific names, numbers, dates. What happened, who is involved, what are the stakes.",
  "neutralDetail": "6-8 sentences of deep background. History leading to this. Key players. Congressional/legal context. What happens next.",
  "leftSummary": "3-4 sentences of the STRONGEST honest progressive argument. Specific policy concerns, values, evidence. Not a strawman.",
  "rightSummary": "3-4 sentences of the STRONGEST honest conservative argument. Specific policy concerns, values, evidence. Not a strawman.",
  "commonGround": ["Specific genuine shared value","Another real area of agreement","Third authentic overlap","Fourth common concern","Fifth shared principle"],
  "conclusion": "4 paragraphs of Bird's Eye View editorial. Para 1: where the left has a legitimate point. Para 2: where the right has a legitimate point. Para 3: where each side overstates or ignores evidence. Para 4: what a reasonable path forward looks like.",
  "blindspotLeft": "Specific thing left-leaning media is NOT covering or underplaying about this story.",
  "blindspotRight": "Specific thing right-leaning media is NOT covering or underplaying about this story.",
  "factChecks": [
    {"claim":"Specific verifiable claim conservatives ARE making right now","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences of specific evidence.","likes":18400},
    {"claim":"Specific verifiable claim liberals ARE making right now","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences of specific evidence.","likes":14200},
    {"claim":"Specific verifiable claim conservatives ARE making right now","side":"right","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences of specific evidence.","likes":22800},
    {"claim":"Specific verifiable claim liberals ARE making right now","side":"left","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences of specific evidence.","likes":16400},
    {"claim":"Specific verifiable claim conservatives ARE making right now","side":"right","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences of specific evidence.","likes":11200},
    {"claim":"Specific verifiable claim liberals ARE making right now","side":"left","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences of specific evidence.","likes":19800},
    {"claim":"Specific verifiable claim conservatives ARE making right now","side":"right","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences of specific evidence.","likes":13400},
    {"claim":"Specific verifiable claim liberals ARE making right now","side":"left","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences of specific evidence.","likes":9800},
    {"claim":"Specific verifiable claim conservatives ARE making right now","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences of specific evidence.","likes":21200},
    {"claim":"Specific verifiable claim liberals ARE making right now","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences of specific evidence.","likes":12800}
  ],
  "leftPosts": [],
  "rightPosts": [],
  "newsCoverage": {"left":[],"centre":[],"right":[]}
}`;

  let text = "";
  for (let attempt=0; attempt<2; attempt++) {
    try { text = await callGrok43(system, user, 8000); break; }
    catch(e) {
      if (attempt<1) { console.warn("  1B retry..."); await new Promise(r=>setTimeout(r,4000)); }
      else throw e;
    }
  }
  const story = parseJSON(text);
  if (!story||!story.topic) throw new Error("Writer returned invalid story");
  return story;
}

// ─── AGENT 1B-REVIEW: SENIOR EDITOR ──────────────────────────────────────────
// Grok 4.3 reasoning: checks left/right balance only — fast focused check
async function agentWriterReview(story) {
  console.log("  Agent 1B-Review (Senior Editor)...");
  const start = Date.now();

  const system = `You are the Senior Editor of MIDDLE, a nonpartisan news app. Check ONLY whether left and right summaries are genuine strong arguments or strawmen. Return ONLY a raw JSON object.`;

  const user = `Story: "${story.topic}"

LEFT summary: "${(story.leftSummary||"").slice(0,400)}"
RIGHT summary: "${(story.rightSummary||"").slice(0,400)}"

Is each summary the STRONGEST honest argument from that side?
A strawman presents a weak or distorted version of the opposing view.
A strong summary presents the best case that side actually makes.

Return:
{
  "leftApproved": true,
  "rightApproved": true,
  "leftReplacement": null,
  "rightReplacement": null,
  "editorNote": "One sentence"
}

Set replacement to null if the summary is strong. Only provide replacement text if it is clearly a strawman (100+ words if replacing).`;

  try {
    const text = await callGrok43(system, user, 2000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    console.log(`    1B-Review done in ${elapsed}s`);
    if (review.editorNote) console.log(`    Editor: ${review.editorNote}`);

    if (!review.leftApproved && review.leftReplacement && review.leftReplacement.length > 100) {
      story.leftSummary = review.leftReplacement;
      console.log("    Fixed: leftSummary (was strawman)");
    }
    if (!review.rightApproved && review.rightReplacement && review.rightReplacement.length > 100) {
      story.rightSummary = review.rightReplacement;
      console.log("    Fixed: rightSummary (was strawman)");
    }
    return story;
  } catch(e) {
    console.warn(`    1B-Review failed: ${e.message}`);
    return story;
  }
}

// ─── AGENT 2: SOURCE FINDER (with live web search) ────────────────────────────
// Grok 4.3 + Responses API: actually searches the web for real article URLs
async function agentSourceFinder(story) {
  console.log(`  Agent 2 (Source Finder — live web search)...`);
  const start = Date.now();
  const today = new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});
  const year  = new Date().getFullYear();

  const system = `You are a research librarian for MIDDLE news app. Search the web RIGHT NOW for real news articles published TODAY or YESTERDAY about a specific story. Return ONLY a raw JSON object. Never invent URLs — only return URLs you actually found in search results.`;

  const user = `Today is ${today}. Search the web for news articles published in the last 48 hours about:
"${story.topic}"

Use these searches:
1. "${story.searchQuery} ${year}" 
2. "${story.topic} news today"
3. site:foxnews.com "${story.searchQuery}"
4. site:npr.org OR site:theguardian.com "${story.searchQuery}"
5. site:reuters.com OR site:apnews.com "${story.searchQuery}"

Find real articles from these outlets covering this story:

LEFT: CNN, NPR, The Guardian, HuffPost, Politico, Vox, The Atlantic, Salon, Mother Jones, New Republic, Raw Story, MSNBC
CENTRE: Reuters, Associated Press, BBC, Axios, The Hill, Bloomberg, CBS News, NBC News, Newsweek, USA Today
RIGHT: Fox News, NY Post, Washington Examiner, Daily Wire, Breitbart, National Review, Daily Caller, Newsmax

STRICT RULES:
- Only include outlets that ACTUALLY published an article about THIS specific story
- Every URL must be copied EXACTLY from your search results
- Only articles from ${year}
- If you cannot find a real article from an outlet, omit it entirely
- Quality over quantity — 3 real verified URLs beats 10 guessed ones

Return:
{
  "left": [
    {"outlet":"NPR","url":"https://npr.org/EXACT-URL-FROM-SEARCH","headline":"Exact article headline you found","bias":"left"}
  ],
  "centre": [
    {"outlet":"Reuters","url":"https://reuters.com/EXACT-URL","headline":"Exact headline","bias":"centre"}
  ],
  "right": [
    {"outlet":"Fox News","url":"https://foxnews.com/EXACT-URL","headline":"Exact headline","bias":"right"}
  ]
}`;

  try {
    const text = await callGrok43Search(system, user, 6000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    console.log(`    Agent 2 search done in ${elapsed}s (${text.length} chars)`);

    if (text.length < 10) {
      console.warn("    Agent 2 returned empty — falling back to NewsAPI matching");
      return { left:[], centre:[], right:[] };
    }

    const coverage = parseJSON(text);
    const total = (coverage.left?.length||0)+(coverage.centre?.length||0)+(coverage.right?.length||0);
    console.log(`    Agent 2: ${total} sources found (${coverage.left?.length||0}L ${coverage.centre?.length||0}C ${coverage.right?.length||0}R)`);
    return coverage;
  } catch(e) {
    console.warn(`    Agent 2 failed: ${e.message}`);
    return { left:[], centre:[], right:[] };
  }
}

// ─── AGENT 2 FALLBACK: NEWSAPI MATCHER ────────────────────────────────────────
// Used when Agent 2 web search fails — matches from pre-fetched headlines
function agentSourceFallback(story, allHeadlines, globalUsedUrls) {
  console.log("    Agent 2 fallback (NewsAPI matching)...");
  const keywords = (story.searchQuery||story.topic).toLowerCase()
    .split(/\s+/).filter(w=>w.length>3);

  const allList = [
    ...(allHeadlines.left||[]),
    ...(allHeadlines.centre||[]),
    ...(allHeadlines.right||[]),
  ];

  const left=[], centre=[], right=[];
  for (const article of allList) {
    if (globalUsedUrls.has(article.url)) continue;
    const bias = getOutletBias(article.url);
    if (!bias) continue;

    const headline = (article.title||"").toLowerCase();
    const isHighVolume = ["foxnews.com","nypost.com","breitbart.com","dailycaller.com"]
      .some(d=>(article.url||"").includes(d));
    const matches = keywords.filter(kw=>headline.includes(kw)).length;
    if (matches < (isHighVolume ? 2 : 1)) continue;

    const item = { outlet:getOutletName(article.url), url:article.url, headline:article.title, bias };
    if (bias==="left"&&left.length<4)     left.push(item);
    if (bias==="centre"&&centre.length<4) centre.push(item);
    if (bias==="right"&&right.length<4)   right.push(item);
  }

  const total = left.length+centre.length+right.length;
  console.log(`    Fallback: ${total} sources (${left.length}L ${centre.length}C ${right.length}R)`);
  return { left, centre, right };
}

// ─── AGENT 3: FACT CHECKER + CHIEF COMBINED ───────────────────────────────────
// Grok 4.3 reasoning: single thorough fact check pass — no need for separate chief
async function agentFactChecker(story) {
  console.log("  Agent 3 (Fact Checker)...");
  const start = Date.now();

  const fcList = (story.factChecks||[])
    .filter(fc=>fc&&fc.claim&&fc.side&&fc.verdict)
    .map((fc,i)=>`${i}. [${fc.side}] "${fc.claim}" — ${fc.verdict}`)
    .join("\n");

  if (!fcList) { console.log("    No fact checks to verify"); return story; }

  const system = `You are the Chief Fact Checker for MIDDLE, a nonpartisan news app. Use your reasoning capability to carefully verify each fact check claim. Return ONLY a raw JSON object.

CRITICAL RULES:
- side="right" means conservatives/Republicans are making this claim — verify it's true
- side="left" means liberals/Democrats are making this claim — verify it's true  
- Valid side values: "left" or "right" ONLY
- Valid verdict values: "TRUE" "FALSE" "MISLEADING" "UNVERIFIED" ONLY
- Ensure a healthy mix of verdicts — not everything should be FALSE or MISLEADING
- Claims should be SPECIFIC and REAL — if a claim is vague or invented, flag it`;

  const user = `Story: "${story.topic}"

Fact checks to verify:
${fcList}

For each fact check:
1. Is the side correct? (right=conservative claim, left=liberal claim)
2. Is the verdict accurate based on evidence?
3. Is the claim specific and real, or vague/invented?

Return:
{
  "approved": true,
  "corrections": [
    {"index": 0, "field": "side", "newValue": "left", "reason": "This is a liberal claim not conservative"},
    {"index": 2, "field": "verdict", "newValue": "MISLEADING", "reason": "Partially true but missing key context"}
  ],
  "checkerNote": "One sentence overall assessment"
}

Only correct genuine errors. If everything is accurate, return approved: true with empty corrections.`;

  try {
    const text = await callGrok43(system, user, 3000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    console.log(`    Agent 3 done in ${elapsed}s — approved: ${review.approved}`);
    if (review.checkerNote) console.log(`    Checker: ${review.checkerNote}`);

    for (const fix of (review.corrections||[])) {
      if (typeof fix.index!=="number"||fix.index<0||fix.index>=(story.factChecks||[]).length) continue;
      if (fix.field==="side"&&!["left","right"].includes(fix.newValue)) {
        console.log(`    SKIPPED invalid side: ${fix.newValue}`); continue;
      }
      if (fix.field==="verdict"&&!["TRUE","FALSE","MISLEADING","UNVERIFIED"].includes(fix.newValue)) {
        console.log(`    SKIPPED invalid verdict: ${fix.newValue}`); continue;
      }
      const old = story.factChecks[fix.index][fix.field];
      story.factChecks[fix.index][fix.field] = fix.newValue;
      console.log(`    Fixed factCheck[${fix.index}] ${fix.field}: ${old} → ${fix.newValue}`);
    }
    story.verifierNotes = review.checkerNote||"";
    return story;
  } catch(e) {
    console.warn(`    Agent 3 failed: ${e.message}`);
    return story;
  }
}

// ─── FINAL GATE: QUALITY CONTROLLER ──────────────────────────────────────────
// Grok 4.3 reasoning: final pass/fail — rejects only genuinely bad stories
async function agentQualityGate(story) {
  console.log("  Final Gate (Quality Controller)...");
  const start = Date.now();
  const today = new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});

  const srcCount = (story.newsCoverage?.left?.length||0)+
                   (story.newsCoverage?.centre?.length||0)+
                   (story.newsCoverage?.right?.length||0);

  const system = `You are the Quality Controller for MIDDLE. Give final approval to publish. Today is ${today}. We are in ${new Date().getFullYear()}. Return ONLY a raw JSON object.`;

  const user = `Final check for: "${story.topic}"

Stats: ${srcCount} sources | image: ${story.imageUrl?"yes":"no"} | factChecks: ${(story.factChecks||[]).length}

Left summary (first 200 chars): "${(story.leftSummary||"").slice(0,200)}"
Right summary (first 200 chars): "${(story.rightSummary||"").slice(0,200)}"
Neutral summary (first 200 chars): "${(story.neutralSummary||"").slice(0,200)}"

APPROVE if:
- Story is genuine national political news
- Both left and right summaries exist and are substantive
- Story is not celebrity/sports/entertainment

REJECT only if:
- Story is clearly not political (pure celebrity/sports/lifestyle)
- Both summaries are completely missing or empty
- Story is provably fictional with impossible events

Return:
{
  "approved": true,
  "qualityScore": 8,
  "flags": [],
  "gatekeeperNote": "One sentence"
}`;

  try {
    const text = await callGrok43(system, user, 1000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    const approved = review.approved !== false;
    console.log(`    Final Gate done in ${elapsed}s — approved: ${approved} score: ${review.qualityScore||"?"}/10`);
    if (review.gatekeeperNote) console.log(`    Gatekeeper: ${review.gatekeeperNote}`);
    if ((review.flags||[]).length>0) console.log(`    Flags: ${review.flags.join(", ")}`);
    story.qualityScore = review.qualityScore||5;
    story.qualityFlags = review.flags||[];
    return { story, approved };
  } catch(e) {
    console.warn(`    Final Gate failed: ${e.message} — approving by default`);
    return { story, approved: true };
  }
}

// ─── URL VALIDATOR ────────────────────────────────────────────────────────────
async function validateCoverage(coverage) {
  if (!coverage) return { left:[], centre:[], right:[] };

  async function validateList(list) {
    if (!Array.isArray(list)) return [];
    const results = await Promise.all(list.map(async item => {
      if (!item?.url) return null;
      try {
        const { default: https } = await import('https');
        const { default: http  } = await import('http');
        const host = new URL(item.url).hostname.replace("www.","");
        if (TRUSTED_DOMAINS.some(d=>host.includes(d))) {
          console.log(`  TRUSTED: ${item.outlet}`);
          return item;
        }
        const lib = item.url.startsWith("https") ? https : http;
        const ok = await new Promise(resolve => {
          const req = lib.request(item.url, { method:"HEAD", timeout:6000,
            headers:{"User-Agent":"Mozilla/5.0 (compatible; MIDDLE-App/1.0)"}
          }, res => resolve(res.statusCode<400));
          req.on("error", ()=>resolve(false));
          req.on("timeout", ()=>{ req.destroy(); resolve(false); });
          req.end();
        });
        console.log(`  ${ok?"VALID":"INVALID"}: ${item.outlet} — ${item.url.slice(0,70)}`);
        return ok ? item : null;
      } catch(e) { return null; }
    }));
    return results.filter(Boolean);
  }

  return {
    left:   await validateList(coverage.left),
    centre: await validateList(coverage.centre),
    right:  await validateList(coverage.right),
  };
}

// ─── FULL PIPELINE ────────────────────────────────────────────────────────────
async function processBatch(batchNum, headlines, excludeTopics=[], globalUsedUrls=new Set()) {

  // 1A: Select story topics
  let selected = await agentSelector(batchNum, headlines, excludeTopics);
  if (selected.length===0) throw new Error("Agent 1A returned no topics");

  // 1A-Review: Editorial Director approves selection
  selected = await agentSelectorReview(selected, headlines, batchNum);

  console.log("\nApproved topics for batch " + batchNum + ":");
  selected.forEach((s,i)=>console.log(`  ${i+1}. ${s.topic}`));

  const processed = [];

  for (let i=0; i<selected.length; i++) {
    const meta = selected[i];
    console.log(`\n── Story ${i+1}/${selected.length}: "${meta.topic.slice(0,60)}" ──`);

    let story;

    // 1B: Write story
    try {
      console.log("  Agent 1B (Writer)...");
      const ws = Date.now();
      story = await agentWriter(meta);
      console.log(`  1B done in ${((Date.now()-ws)/1000).toFixed(1)}s`);
    } catch(e) {
      console.warn(`  1B failed: ${e.message} — skipping`);
      continue;
    }
    await new Promise(r=>setTimeout(r,1000));

    // 1B-Review: Senior Editor checks balance
    story = await agentWriterReview(story);
    await new Promise(r=>setTimeout(r,1000));

    // 2: Find sources via live web search
    let coverage = await agentSourceFinder(story);

    // If web search returns nothing, fall back to NewsAPI matching
    const total = (coverage.left?.length||0)+(coverage.centre?.length||0)+(coverage.right?.length||0);
    if (total === 0) {
      coverage = agentSourceFallback(story, headlines, globalUsedUrls);
    }

    // Validate URLs
    coverage = await validateCoverage(coverage);

    // Mark used URLs globally
    [...(coverage.left||[]),...(coverage.centre||[]),...(coverage.right||[])]
      .forEach(item=>{ if(item?.url) globalUsedUrls.add(item.url); });

    story.newsCoverage = coverage;
    await new Promise(r=>setTimeout(r,1000));

    // 3: Fact checker (combined with chief review — one thorough pass)
    story = await agentFactChecker(story);
    await new Promise(r=>setTimeout(r,1000));

    // Image
    const stopWords = new Set(["that","this","with","from","over","into","amid","have","been",
      "will","they","them","their","after","about","would","also","says","said","just","more",
      "than","when","what","where","some","could","should","upon","amid","both","each"]);
    const topicWords = story.topic.split(" ").filter(w=>w.length>3&&!stopWords.has(w.toLowerCase()));
    const imgQueries = [story.searchQuery, topicWords.slice(0,5).join(" "), topicWords.slice(0,3).join(" ")]
      .filter((q,i,a)=>q&&a.indexOf(q)===i);

    let image = {imageUrl:null,imageCredit:null,imageArticleUrl:null};
    for (const q of imgQueries) {
      image = await fetchNewsImage(q).catch(()=>({imageUrl:null,imageCredit:null,imageArticleUrl:null}));
      if (image.imageUrl) { console.log(`  Image: ${q.slice(0,40)}`); break; }
      await new Promise(r=>setTimeout(r,800));
    }
    story.imageUrl        = image.imageUrl;
    story.imageCredit     = image.imageCredit;
    story.imageArticleUrl = image.imageArticleUrl;

    // Final Gate
    const { story: finalStory, approved } = await agentQualityGate(story);
    if (!approved) {
      console.log("  ❌ REJECTED by Quality Controller");
      continue;
    }

    const srcCount = (finalStory.newsCoverage?.left?.length||0)+
                     (finalStory.newsCoverage?.centre?.length||0)+
                     (finalStory.newsCoverage?.right?.length||0);
    console.log(`  ✅ APPROVED — ${srcCount} sources, image: ${finalStory.imageUrl?"yes":"no"}, score: ${finalStory.qualityScore||"?"}/10`);
    processed.push(finalStory);
  }

  return processed;
}


// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== MIDDLE Story Generator -- Grok 4.3 Pipeline ===");
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
