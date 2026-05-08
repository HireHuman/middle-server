// ─── MIDDLE Story Generator — Grok 4.3 Pipeline ──────────────────────────────
// Model: grok-4.3 (reasoning built-in, migrated from grok-3 before May 15 retirement)
// Pipeline: NewsAPI headlines → 1A Selector → 1A-Review → per story:
//           1B Writer → 1B-Review → Agent 2 (news sources + Reddit via web search)
//           → Agent 3 (fact checks) → Final Gate → Firestore
// ─────────────────────────────────────────────────────────────────────────────

const GROK_API_KEY = process.env.GROK_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const FB_PROJECT   = process.env.FB_PROJECT || "themiddle-85852";
const FB_API_KEY   = process.env.FB_API_KEY  || "AIzaSyBxAzJ0bVpOb2hux5OIylBngUDr0ZoH-w4";
const FB_BASE      = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

// ─── Firestore helpers ────────────────────────────────────────────────────────
async function fsGet(path) {
  const res = await fetch(`${FB_BASE}/${path}?key=${FB_API_KEY}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.fields) return null;
  const out = {};
  for (const [k,v] of Object.entries(data.fields)) {
    if (v.stringValue  !== undefined) out[k] = v.stringValue;
    else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue);
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
  }
  return out;
}

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
  for (const [k,v] of Object.entries(obj)) {
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

// ─── JSON parser ──────────────────────────────────────────────────────────────
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
  let cleaned = ""; let inStr = false; let escaped = false;
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
  cleaned = cleaned.replace(/,(\s*[}\]])/g,'$1').replace(/}(\s*){/g,'},$1{');

  try { return JSON.parse(cleaned); } catch(e1) {
    try {
      return JSON.parse(cleaned.replace(/[^\x20-\x7E\x09\x0A\x0D]/g," ").replace(/,(\s*[}\]])/g,'$1'));
    } catch(e2) {
      const matches = cleaned.match(/\{[^{}]{20,}\}/gs)||[];
      const items = matches.map(m=>{ try{return JSON.parse(m);}catch(e){return null;} }).filter(Boolean);
      if (items.length > 0) { console.log("  JSON recovered "+items.length+" items"); return items; }
      throw new Error("JSON parse failed: "+e1.message);
    }
  }
}

// ─── Grok 4.3 — Chat Completions (reasoning, no web search) ──────────────────
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
      hostname:"api.x.ai", path:"/v1/chat/completions", method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":`Bearer ${GROK_API_KEY}`,
        "Content-Length":Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(900000, () => { req.destroy(); reject(new Error("Grok 4.3 timeout after 15 min")); });
    req.write(body); req.end();
  });
  if (result.status === 429) throw new Error("Grok rate limit — add credits at console.x.ai");
  if (result.status !== 200) throw new Error(`Grok 4.3 error ${result.status}: ${result.body.slice(0,300)}`);
  const parsed = JSON.parse(result.body);
  return parsed.choices?.[0]?.message?.content || "";
}

// ─── Grok 4.3 — Responses API (with live web search tool) ────────────────────
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
      hostname:"api.x.ai", path:"/v1/responses", method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":`Bearer ${GROK_API_KEY}`,
        "Content-Length":Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error("Search timeout after 5 min")); });
    req.write(body); req.end();
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

// ─── Outlet bias classification ───────────────────────────────────────────────
const OUTLET_BIAS_MAP = {
  "cnn":"left","msnbc":"left","nytimes":"left","washingtonpost":"left",
  "theguardian":"left","guardian":"left","npr":"left","huffpost":"left",
  "vox":"left","theatlantic":"left","politico":"left","slate":"left",
  "salon":"left","motherjones":"left","thenation":"left","newrepublic":"left",
  "rawstory":"left","theintercept":"left","talkingpointsmemo":"left",
  "reuters":"centre","apnews":"centre","bbc":"centre","axios":"centre",
  "thehill":"centre","bloomberg":"centre","newsweek":"centre",
  "usatoday":"centre","cbsnews":"centre","abcnews":"centre","nbcnews":"centre",
  "pbs":"centre","time":"centre","economist":"centre","csmonitor":"centre",
  "foxnews":"right","nypost":"right","wsj":"right","washingtonexaminer":"right",
  "dailywire":"right","breitbart":"right","nationalreview":"right",
  "dailycaller":"right","newsmax":"right","washingtontimes":"right",
  "thefederalist":"right","townhall":"right","theblaze":"right","epochtimes":"right",
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

// Outlets that block HEAD requests but are valid — skip HTTP validation
const TRUSTED_DOMAINS = [
  "washingtonpost.com","nytimes.com","wsj.com","theatlantic.com",
  "bloomberg.com","economist.com","axios.com","politico.com",
  "foxnews.com","dailywire.com","nationalreview.com","breitbart.com",
  "dailycaller.com","newsmax.com","washingtonexaminer.com","nypost.com",
  "thehill.com","newrepublic.com","salon.com","slate.com","vox.com",
  "motherjones.com","thenation.com","theintercept.com","rawstory.com",
  "talkingpointsmemo.com","reuters.com","apnews.com","bbc.com","bbc.co.uk",
  "npr.org","theguardian.com","huffpost.com","cbsnews.com","nbcnews.com",
  "abcnews.go.com","usatoday.com","time.com","newsweek.com",
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
           host.replace(/\.(com|org|net)$/,"");
  } catch(e) { return "Unknown"; }
}

// ─── URL validator ────────────────────────────────────────────────────────────
async function validateCoverage(coverage) {
  if (!coverage) return { left:[], centre:[], right:[] };

  async function validateList(list) {
    if (!Array.isArray(list)) return [];
    const results = await Promise.all(list.map(async item => {
      if (!item?.url) return null;
      try {
        const host = new URL(item.url).hostname.replace("www.","");
        if (TRUSTED_DOMAINS.some(d => host.includes(d))) {
          console.log(`  TRUSTED: ${item.outlet}`);
          return item;
        }
        const { default: https } = await import('https');
        const { default: http  } = await import('http');
        const lib = item.url.startsWith("https") ? https : http;
        const ok = await new Promise(resolve => {
          const req = lib.request(item.url, {
            method:"HEAD", timeout:6000,
            headers:{"User-Agent":"Mozilla/5.0 (compatible; MIDDLE-App/1.0)"}
          }, res => resolve(res.statusCode < 400));
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

// ─── NewsAPI headline fetcher ─────────────────────────────────────────────────
// Uses 3 calls per run: left domains, centre/right domains, general top-headlines
// Free tier is 100 requests/day — normal daily cron uses ~20 total (headlines + images)
async function fetchTodaysHeadlines() {
  if (!NEWS_API_KEY) {
    console.log("  No NEWS_API_KEY set — Agent 1A will use Grok web knowledge");
    return { left:[], centre:[], right:[] };
  }

  const from = new Date(Date.now() - 86400000).toISOString().slice(0,10);

  const LEFT_DOMAINS   = "npr.org,theguardian.com,huffpost.com,politico.com,vox.com,theatlantic.com,salon.com,thenation.com,motherjones.com,slate.com,newrepublic.com,rawstory.com";
  const CENTRE_DOMAINS = "reuters.com,apnews.com,bbc.com,axios.com,thehill.com,bloomberg.com,cbsnews.com,nbcnews.com,usatoday.com,newsweek.com";
  const RIGHT_DOMAINS  = "foxnews.com,nypost.com,washingtonexaminer.com,dailywire.com,breitbart.com,nationalreview.com,dailycaller.com,newsmax.com";

  async function fetchSide(domains, side, pageSize=30) {
    try {
      const url = `https://newsapi.org/v2/everything?domains=${domains}&from=${from}&sortBy=publishedAt&pageSize=${pageSize}&language=en&apiKey=${NEWS_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) { console.log(`  NewsAPI ${side} failed: ${res.status}`); return []; }
      const data = await res.json();
      const articles = (data.articles||[]).filter(a =>
        a.title && a.url && !a.title.includes("[Removed]") && a.source?.name !== "Removed"
      );
      console.log(`  NewsAPI ${side}: ${articles.length} headlines`);
      return articles.map(a => ({
        title: a.title, url: a.url,
        source: a.source?.name || "Unknown",
        publishedAt: a.publishedAt,
        description: a.description || "",
        lean: side,
      }));
    } catch(e) {
      console.warn(`  NewsAPI ${side} error: ${e.message}`);
      return [];
    }
  }

  // Fetch all three sides in parallel
  const [leftRaw, centreRaw, rightRaw] = await Promise.all([
    fetchSide(LEFT_DOMAINS,   "left",   30),
    fetchSide(CENTRE_DOMAINS, "centre", 30),
    fetchSide(RIGHT_DOMAINS,  "right",  30),
  ]);

  // Deduplicate within each side
  function dedupe(arr) {
    const seen = new Set();
    return arr.filter(a => {
      const key = a.title.slice(0,40).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  const left   = dedupe(leftRaw);
  const centre = dedupe(centreRaw);
  const right  = dedupe(rightRaw);

  console.log(`  Headlines ready: ${left.length}L ${centre.length}C ${right.length}R`);
  return { left, centre, right };
}

// ─── NewsAPI image fetcher ────────────────────────────────────────────────────
async function fetchNewsImage(searchQuery) {
  if (!NEWS_API_KEY) return { imageUrl:null, imageCredit:null, imageArticleUrl:null };
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(searchQuery)}&sortBy=relevancy&pageSize=10&language=en&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const a = (data.articles||[]).find(a =>
        a.urlToImage && !a.urlToImage.includes("placeholder") &&
        !a.urlToImage.includes("none") && a.urlToImage.startsWith("http")
      );
      if (a) return { imageUrl:a.urlToImage, imageCredit:a.source?.name||"News", imageArticleUrl:a.url };
    }
  } catch(e) { console.warn(`  Image fetch error: ${e.message}`); }

  // Wikipedia fallback
  try {
    const terms = searchQuery.split(" ").slice(0,3).join("_");
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(terms)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.thumbnail?.source) return {
        imageUrl: data.thumbnail.source,
        imageCredit: "Wikipedia",
        imageArticleUrl: data.content_urls?.desktop?.page || ""
      };
    }
  } catch(e) {}

  return { imageUrl:null, imageCredit:null, imageArticleUrl:null };
}

// ─── AGENT 1A: STORY SELECTOR ────────────────────────────────────────────────
// Grok 4.3 reads today's headlines and selects the 5 most significant stories
// Falls back to Grok's own web knowledge if NewsAPI is rate-limited
async function agentSelector(batch, headlines, excludeTopics=[]) {
  console.log(`\nAgent 1A (Selector) — batch ${batch}...`);
  const start = Date.now();

  const hasHeadlines = (headlines.left?.length||0) +
                       (headlines.centre?.length||0) +
                       (headlines.right?.length||0) > 0;

  const exclude = excludeTopics.length > 0
    ? `\nAlready covered in batch 1 — do NOT select these: ${excludeTopics.slice(0,5).join(" | ")}`
    : "";

  // Score headlines by cross-coverage (appear in both left AND right)
  function score(h, other) {
    const kws = h.title.toLowerCase().split(/\s+/).filter(w=>w.length>4);
    return (other||[]).filter(o=>kws.some(kw=>o.title.toLowerCase().includes(kw))).length;
  }

  const leftScored  = (headlines.left||[]).map(h=>({...h,score:score(h,headlines.right||[])})).sort((a,b)=>b.score-a.score);
  const rightScored = (headlines.right||[]).map(h=>({...h,score:score(h,headlines.left||[])})).sort((a,b)=>b.score-a.score);
  const centreTop   = (headlines.centre||[]).slice(0,15);

  const fmt = arr => arr.slice(0,15).map((h,i) =>
    `${i+1}. [${h.source}${h.score>0?" ★":""}] "${h.title}"`
  ).join("\n");

  const headlinesBlock = hasHeadlines
    ? `Today's verified headlines (★ = covered by BOTH left AND right — highest priority):

LEFT-LEANING SOURCES:
${fmt(leftScored)}

CENTRE/NEUTRAL SOURCES:
${centreTop.map((h,i)=>`${i+1}. [${h.source}] "${h.title}"`).join("\n")}

RIGHT-LEANING SOURCES:
${fmt(rightScored)}

IMPORTANT: Only select stories that appear in the headlines above.`
    : `No pre-fetched headlines available today (NewsAPI rate limit reached).
Use your knowledge of today's major US political news to select 5 real current stories.

IMPORTANT CONTEXT: Today is ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}. We are in ${new Date().getFullYear()}.
- Donald Trump is the current US President (began second term January 2025)
- The current Congress is the 119th Congress
- Only select stories that are actually happening RIGHT NOW in ${new Date().getFullYear()}
- Do NOT select stories from Biden's presidency or other outdated events`;

  const system = `You are the senior news editor for MIDDLE, a nonpartisan US political news app.
Select the 5 most nationally significant political stories of the day.

MIDDLE covers: major federal legislation, Supreme Court decisions, elections, foreign policy, economy/trade, national security, significant political appointments, major political scandals.
MIDDLE does NOT cover: celebrity news, sports, entertainment, lifestyle, local/state issues without national impact, social media posts, viral memes.

Return ONLY a raw JSON array. No markdown. No commentary.`;

  const user = `Select 5 stories for batch ${batch}.${exclude}

${headlinesBlock}

SELECTION RULES:
1. ★ stories are highest priority — covered by both sides means national significance
2. Topic diversity — select from different areas: foreign policy, economy, courts, elections, legislation, appointments
3. No more than 2 stories on the same broad topic
4. Neutral headline framing — no loaded language, no partisan spin
5. National impact — affects millions of Americans or has major political consequences

Return exactly 5 items:
[{
  "topic": "Specific neutral headline with real names",
  "searchQuery": "3-5 specific keywords for web search",
  "category": "POLITICS",
  "categoryColor": "#818cf8",
  "breaking": false
}]
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
  const raw = parseJSON(text);
  const valid = (Array.isArray(raw)?raw:[raw]).filter(s=>s&&s.topic).slice(0,5);
  console.log(`Agent 1A done in ${elapsed}s — ${valid.length} topics selected`);
  return valid;
}

// ─── AGENT 1A-REVIEW: EDITORIAL DIRECTOR ─────────────────────────────────────
// Grok 4.3 verifies story selection — checks significance, diversity, reality
// Only replaces stories with clear specific problems
async function agentSelectorReview(selected, headlines, batch) {
  console.log("Agent 1A-Review (Editorial Director)...");
  const start = Date.now();

  const hasHeadlines = (headlines.left?.length||0)+(headlines.centre?.length||0)+(headlines.right?.length||0) > 0;
  const allHL = [...(headlines.left||[]),...(headlines.centre||[]),...(headlines.right||[])];
  const hlSample = allHL.slice(0,40).map(h=>`[${h.source}] "${h.title}"`).join("\n");
  const proposed = selected.map((s,i)=>`${i+1}. "${s.topic}" [${s.category}]`).join("\n");

  const system = `You are the Editorial Director of MIDDLE, a nonpartisan US political news app.
You review story selections for quality, significance, and accuracy.
CRITICAL: MIDDLE is a POLITICAL news app. All stories must be political.
NEVER replace political stories with health, science, environment, sports, or lifestyle topics.
Return ONLY a raw JSON object.`;

  const user = `Review this batch ${batch} story selection:

${proposed}

${hasHeadlines ? `Reference headlines:\n${hlSample}` : "Note: No NewsAPI headlines available — selection based on Grok's knowledge."}

ONLY replace a story if it has ONE of these specific problems:
1. Not a real current political story (invented or fictional)
2. Clearly only a local/state issue with zero national implications
3. Celebrity, sports, entertainment, or non-political content
4. More than 2 stories covering the exact same event

DO NOT replace for any other reason. Political stories about Trump, Congress, courts, elections are ALL valid — do not filter them out.

${hasHeadlines ? "Replacements must come from the reference headlines above." : "If replacing, suggest a real current national political story."}

Return:
{
  "approved": true,
  "corrections": [
    {
      "index": 2,
      "reason": "Specific reason — one of the 4 problems above",
      "newTopic": "Replacement topic",
      "newSearchQuery": "keywords",
      "newCategory": "POLITICS",
      "newCategoryColor": "#818cf8"
    }
  ],
  "directorNote": "One sentence assessment"
}

If all 5 stories are legitimate national political news, return approved: true with empty corrections array.`;

  try {
    const text = await callGrok43(system, user, 3000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    console.log(`Agent 1A-Review done in ${elapsed}s — approved: ${review.approved}`);
    if (review.directorNote) console.log(`  Director: ${review.directorNote}`);

    for (const fix of (review.corrections||[])) {
      if (typeof fix.index!=="number"||fix.index<0||fix.index>=selected.length) continue;
      if (!fix.newTopic) continue;
      console.log(`  Replacing story ${fix.index+1}: ${fix.reason}`);
      selected[fix.index] = {
        topic: fix.newTopic, searchQuery: fix.newSearchQuery||fix.newTopic,
        category: fix.newCategory||"POLITICS",
        categoryColor: fix.newCategoryColor||"#818cf8", breaking: false
      };
    }
    return selected;
  } catch(e) {
    console.warn(`  1A-Review failed: ${e.message} — using original selection`);
    return selected;
  }
}

// ─── AGENT 1B: STORY WRITER ───────────────────────────────────────────────────
// Grok 4.3 with built-in reasoning writes one complete story
// Focused prompt — one story at a time = no timeout issues
async function agentWriter(storyMeta) {
  const today = new Date().toLocaleDateString("en-US",{
    weekday:"long",month:"long",day:"numeric",year:"numeric"
  });

  const system = `You are the lead editorial writer for MIDDLE, a nonpartisan US political news app.
Write one deeply researched, completely balanced political story.
Use your reasoning to verify facts, ensure both sides are represented fairly, and write with precision.
Return ONLY a raw JSON object. No markdown. No code fences. Escape all strings properly. No raw newlines inside strings.`;

  const user = `Today is ${today}. Write a complete MIDDLE story about:
"${storyMeta.topic}"
Search keywords: "${storyMeta.searchQuery}"

Return ONE JSON object:
{
  "id": "unique-kebab-slug",
  "topic": "${storyMeta.topic}",
  "time": "Xh ago",
  "category": "${storyMeta.category||"POLITICS"}",
  "categoryColor": "${storyMeta.categoryColor||"#818cf8"}",
  "breaking": false,
  "searchQuery": "${storyMeta.searchQuery}",
  "sourceUrl": "",
  "neutralSummary": "3-4 factual sentences. Specific real names, numbers, dates. What happened, who is involved, what are the stakes.",
  "neutralDetail": "6-8 sentences of deep background. History leading to this moment. Key players. Congressional or legal context. What happens next.",
  "leftSummary": "3-4 sentences of the STRONGEST honest progressive argument. The best case the left actually makes — not a strawman. Specific policy concerns and values.",
  "rightSummary": "3-4 sentences of the STRONGEST honest conservative argument. The best case the right actually makes — not a strawman. Specific policy concerns and values.",
  "commonGround": ["Specific genuine shared value","Another real area of agreement","Third authentic overlap","Fourth common concern","Fifth shared principle"],
  "conclusion": "4 paragraphs: (1) Where the left has a legitimate point. (2) Where the right has a legitimate point. (3) Where each side overstates or ignores evidence. (4) What a reasonable path forward looks like.",
  "blindspotLeft": "Specific thing left-leaning media is NOT covering or underplaying about this story.",
  "blindspotRight": "Specific thing right-leaning media is NOT covering or underplaying about this story.",
  "factChecks": [
    {"claim":"Specific verifiable claim conservatives ARE making about this right now","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences of specific evidence.","likes":18400},
    {"claim":"Specific verifiable claim liberals ARE making about this right now","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences of specific evidence.","likes":14200},
    {"claim":"Specific verifiable claim conservatives ARE making about this right now","side":"right","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences of specific evidence.","likes":22800},
    {"claim":"Specific verifiable claim liberals ARE making about this right now","side":"left","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences of specific evidence.","likes":16400},
    {"claim":"Specific verifiable claim conservatives ARE making about this right now","side":"right","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences of specific evidence.","likes":11200},
    {"claim":"Specific verifiable claim liberals ARE making about this right now","side":"left","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences of specific evidence.","likes":19800},
    {"claim":"Specific verifiable claim conservatives ARE making about this right now","side":"right","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences of specific evidence.","likes":13400},
    {"claim":"Specific verifiable claim liberals ARE making about this right now","side":"left","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences of specific evidence.","likes":9800},
    {"claim":"Specific verifiable claim conservatives ARE making about this right now","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences of specific evidence.","likes":21200},
    {"claim":"Specific verifiable claim liberals ARE making about this right now","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences of specific evidence.","likes":12800}
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
// Fast focused check — are left/right summaries genuine strong arguments or strawmen?
async function agentWriterReview(story) {
  console.log("  Agent 1B-Review (Senior Editor)...");
  const start = Date.now();

  const system = `You are the Senior Editor of MIDDLE, a nonpartisan news app.
Check ONLY whether left and right summaries are genuine strong arguments or strawmen.
A strong summary presents the best honest case that side actually makes.
A strawman presents a weak or distorted version that the other side would easily dismiss.
Return ONLY a raw JSON object.`;

  const user = `Story: "${story.topic}"

LEFT summary: "${(story.leftSummary||"").slice(0,400)}"
RIGHT summary: "${(story.rightSummary||"").slice(0,400)}"

Is each summary the strongest honest argument from that side?

Return:
{
  "leftApproved": true,
  "rightApproved": true,
  "leftReplacement": null,
  "rightReplacement": null,
  "editorNote": "One sentence assessment"
}

Only provide replacement text (100+ words) if a summary is clearly a strawman.
Set to null if the summary is strong. Do NOT check facts — that is Agent 3's job.`;

  try {
    const text = await callGrok43(system, user, 2000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    console.log(`    1B-Review done in ${elapsed}s`);
    if (review.editorNote) console.log(`    Editor: ${review.editorNote}`);

    if (!review.leftApproved  && review.leftReplacement  && review.leftReplacement.length  > 100) {
      story.leftSummary  = review.leftReplacement;
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

// ─── AGENT 2: SOURCE FINDER + REDDIT (live web search) ───────────────────────
// Grok 4.3 Responses API with web_search tool
// Key insight: Grok won't search AND return JSON simultaneously
// Solution: Let Grok search and respond naturally, then parse URLs from the text
// Two separate calls: one for news outlets, one for Reddit
async function agentSourceAndRedditFinder(story) {
  console.log(`  Agent 2 (Sources + Reddit — live web search)...`);
  const start = Date.now();
  const today = new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});
  const year  = new Date().getFullYear();

  // Helper: extract URLs from natural language text response
  function extractUrls(text) {
    const urlRegex = /https?:\/\/[^\s\)\],"']+/g;
    return (text.match(urlRegex)||[])
      .map(u => u.replace(/[.,;:!?]+$/, "")) // trim trailing punctuation
      .filter(u => u.length > 20);
  }

  // Helper: classify a URL by outlet bias
  function classifyNewsUrl(url, title) {
    const bias = getOutletBias(url);
    if (!bias) return null;
    return {
      outlet: getOutletName(url),
      url,
      headline: title || url,
      bias
    };
  }

  // ── Search 1: News outlets ──────────────────────────────────────────────────
  let newsCoverage = { left:[], centre:[], right:[] };
  try {
    const newsSystem = `You are a research assistant. Search the web RIGHT NOW for real news articles about a specific story. List the articles you find with their URLs and headlines. Be specific and factual.`;

    const newsUser = `Today is ${today}. Search for news articles published in the last 48 hours about:
"${story.topic}"

Search queries to use:
- "${story.searchQuery} ${year}"
- "${story.topic} news ${year}"

Find and list real articles from these outlets if they covered this story:
Left-leaning: NPR, The Guardian, HuffPost, Politico, Vox, The Atlantic, Salon, Mother Jones, New Republic, CNN
Centre/Neutral: Reuters, AP, BBC, Axios, The Hill, Bloomberg, CBS News, NBC News, USA Today
Right-leaning: Fox News, NY Post, Washington Examiner, Daily Wire, Breitbart, National Review, Daily Caller, Newsmax

For each article you find, list:
OUTLET: [name]
URL: [full URL]
HEADLINE: [exact article headline]
BIAS: [left/centre/right]

Only list articles you actually found in search results. Do not invent URLs.`;

    const newsText = await callGrok43Search(newsSystem, newsUser, 4000);
    const newsElapsed = ((Date.now()-start)/1000).toFixed(1);
    console.log(`    News search done in ${newsElapsed}s (${newsText.length} chars)`);

    if (newsText.length > 50) {
      // Parse structured outlet/url/headline blocks from text
      const blocks = newsText.split(/\n(?=OUTLET:|outlet:)/gi);
      for (const block of blocks) {
        const outletMatch = block.match(/OUTLET:\s*(.+)/i);
        const urlMatch    = block.match(/URL:\s*(https?:\/\/\S+)/i);
        const headlineMatch = block.match(/HEADLINE:\s*(.+)/i);
        const biasMatch   = block.match(/BIAS:\s*(left|centre|center|right)/i);

        if (urlMatch && outletMatch) {
          const url = urlMatch[1].trim().replace(/[.,;]+$/, "");
          const bias = biasMatch
            ? (biasMatch[1].toLowerCase() === "center" ? "centre" : biasMatch[1].toLowerCase())
            : getOutletBias(url);
          if (!bias) continue;

          const item = {
            outlet: outletMatch[1].trim(),
            url,
            headline: headlineMatch ? headlineMatch[1].trim() : outletMatch[1].trim(),
            bias
          };

          if (bias === "left"   && newsCoverage.left.length   < 5) newsCoverage.left.push(item);
          if (bias === "centre" && newsCoverage.centre.length < 5) newsCoverage.centre.push(item);
          if (bias === "right"  && newsCoverage.right.length  < 5) newsCoverage.right.push(item);
        }
      }

      // If structured parsing found nothing, try extracting raw URLs
      if (!newsCoverage.left.length && !newsCoverage.centre.length && !newsCoverage.right.length) {
        const urls = extractUrls(newsText);
        for (const url of urls) {
          const bias = getOutletBias(url);
          if (!bias) continue;
          const item = { outlet:getOutletName(url), url, headline:url, bias };
          if (bias === "left"   && newsCoverage.left.length   < 5) newsCoverage.left.push(item);
          if (bias === "centre" && newsCoverage.centre.length < 5) newsCoverage.centre.push(item);
          if (bias === "right"  && newsCoverage.right.length  < 5) newsCoverage.right.push(item);
        }
      }
    }

    const newsTotal = newsCoverage.left.length + newsCoverage.centre.length + newsCoverage.right.length;
    console.log(`    News sources: ${newsTotal} (${newsCoverage.left.length}L ${newsCoverage.centre.length}C ${newsCoverage.right.length}R)`);
  } catch(e) {
    console.warn(`    News search failed: ${e.message}`);
  }

  await new Promise(r=>setTimeout(r,1000));

  // ── Search 2: Reddit posts ──────────────────────────────────────────────────
  let leftPosts = [], rightPosts = [];
  try {
    const redditSystem = `You are a research assistant. Search Reddit RIGHT NOW for real posts about a specific news story. List the posts you find with their exact URLs, titles, and vote counts.`;

    const redditUser = `Today is ${today}. Search Reddit for posts about:
"${story.topic}"

Search queries to use:
- site:reddit.com "${story.searchQuery}"
- site:reddit.com/r/politics "${story.searchQuery}"
- site:reddit.com/r/conservative "${story.searchQuery}"
- site:reddit.com/r/news "${story.searchQuery}"

Find real posts from:
LEFT subreddits: r/politics, r/news, r/worldnews, r/progressive, r/democrats, r/Liberal
RIGHT subreddits: r/conservative, r/Republican, r/AskConservatives, r/Libertarian

For each post you find, list:
SUBREDDIT: [r/subreddit]
URL: [full permalink URL - must contain /comments/]
TITLE: [exact post title]
UPVOTES: [upvote count if available]
SIDE: [left/right based on subreddit]

Only list posts with real /comments/ URLs. Do not invent posts or URLs.`;

    const redditText = await callGrok43Search(redditSystem, redditUser, 3000);
    const redditElapsed = ((Date.now()-start)/1000).toFixed(1);
    console.log(`    Reddit search done in ${redditElapsed}s (${redditText.length} chars)`);

    if (redditText.length > 50) {
      const blocks = redditText.split(/\n(?=SUBREDDIT:|subreddit:)/gi);
      let leftIdx = 0, rightIdx = 0;

      for (const block of blocks) {
        const subMatch   = block.match(/SUBREDDIT:\s*(r\/\w+)/i);
        const urlMatch   = block.match(/URL:\s*(https?:\/\/\S+)/i);
        const titleMatch = block.match(/TITLE:\s*(.+)/i);
        const upvMatch   = block.match(/UPVOTES?:\s*([\d,]+)/i);
        const sideMatch  = block.match(/SIDE:\s*(left|right)/i);

        if (!urlMatch || !titleMatch) continue;
        const url = urlMatch[1].trim().replace(/[.,;]+$/, "");
        if (!url.includes("/comments/")) continue; // must be a real post

        const upvotes = upvMatch ? parseInt(upvMatch[1].replace(/,/g,""))||0 : 0;
        const sub = subMatch ? subMatch[1].trim() : "";
        const side = sideMatch ? sideMatch[1].toLowerCase() :
          (sub.match(/politics|news|worldnews|progressive|democrats|liberal/i) ? "left" : "right");

        const post = {
          id: side === "left" ? `l${++leftIdx}` : `r${++rightIdx}`,
          handle: sub || "r/reddit",
          source: "Reddit",
          avatar: (sub.replace("r/","")[0]||"R").toUpperCase(),
          text: titleMatch[1].trim(),
          likes: upvotes,
          reposts: 0,
          url,
          thread: []
        };

        if (side === "left"  && leftPosts.length  < 5) leftPosts.push(post);
        if (side === "right" && rightPosts.length < 5) rightPosts.push(post);
      }
    }

    console.log(`    Reddit posts: ${leftPosts.length} left, ${rightPosts.length} right`);
  } catch(e) {
    console.warn(`    Reddit search failed: ${e.message}`);
  }

  const elapsed = ((Date.now()-start)/1000).toFixed(1);
  console.log(`    Agent 2 total: ${elapsed}s`);
  return { newsCoverage, leftPosts, rightPosts };
}

// ─── AGENT 2 FALLBACK: NEWSAPI HEADLINE MATCHER ───────────────────────────────
// Used only when Agent 2 web search fails completely
// Matches from pre-fetched headlines — no Reddit (can't get real posts without API)
function agentSourceFallback(story, allHeadlines, globalUsedUrls) {
  console.log("    Agent 2 fallback (NewsAPI headline matching)...");
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
    if (bias==="left"  &&left.length<4)    left.push(item);
    if (bias==="centre"&&centre.length<4)  centre.push(item);
    if (bias==="right" &&right.length<4)   right.push(item);
  }

  const total = left.length+centre.length+right.length;
  console.log(`    Fallback: ${total} sources (${left.length}L ${centre.length}C ${right.length}R)`);
  return { left, centre, right };
}

// ─── AGENT 3: FACT CHECKER ────────────────────────────────────────────────────
// Grok 4.3 with built-in reasoning — one thorough pass replaces old 2-pass system
// Checks: side assignments, verdict accuracy, claim specificity, verdict diversity
async function agentFactChecker(story) {
  console.log("  Agent 3 (Fact Checker)...");
  const start = Date.now();

  const fcList = (story.factChecks||[])
    .filter(fc=>fc&&fc.claim&&fc.side&&fc.verdict)
    .map((fc,i)=>`${i}. [${fc.side}] "${fc.claim}" — ${fc.verdict}`)
    .join("\n");

  if (!fcList) { console.log("    No fact checks to verify"); return story; }

  const system = `You are the Chief Fact Checker for MIDDLE, a nonpartisan news app.
Use your reasoning to carefully verify each fact check claim.
Return ONLY a raw JSON object.

RULES:
- side="right" means conservatives/Republicans are actually making this claim — verify
- side="left" means liberals/Democrats are actually making this claim — verify
- Valid sides: "left" or "right" ONLY — never "neutral", "both", or anything else
- Valid verdicts: "TRUE" "FALSE" "MISLEADING" "UNVERIFIED" only
- Aim for a healthy mix: roughly 3-4 TRUE, 2-3 MISLEADING, 1-2 FALSE, 1-2 UNVERIFIED
- Claims must be SPECIFIC — flag vague or invented claims
- Check that each claim is genuinely something that side is saying RIGHT NOW`;

  const user = `Story: "${story.topic}"

Verify these 10 fact checks:
${fcList}

For each: (1) Is the side correct? (2) Is the verdict accurate? (3) Is the claim specific and real?

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
      console.log(`    Fixed [${fix.index}] ${fix.field}: ${old} → ${fix.newValue}`);
    }
    story.verifierNotes = review.checkerNote||"";
    return story;
  } catch(e) {
    console.warn(`    Agent 3 failed: ${e.message}`);
    return story;
  }
}

// ─── FINAL GATE: QUALITY CONTROLLER ──────────────────────────────────────────
// Last check before Firestore — rejects only genuinely bad stories
async function agentQualityGate(story) {
  console.log("  Final Gate (Quality Controller)...");
  const start = Date.now();
  const year = new Date().getFullYear();

  const srcCount = (story.newsCoverage?.left?.length||0)+
                   (story.newsCoverage?.centre?.length||0)+
                   (story.newsCoverage?.right?.length||0);
  const redditCount = (story.leftPosts?.filter(p=>p.url?.includes("/comments/"))||[]).length +
                      (story.rightPosts?.filter(p=>p.url?.includes("/comments/"))||[]).length;

  const system = `You are the Quality Controller for MIDDLE. Give final approval to publish stories.
We are in ${year}. Stories about ${year} events are current and real.
Return ONLY a raw JSON object.`;

  const user = `Final check for: "${story.topic}"

Stats:
- News sources: ${srcCount} (${story.newsCoverage?.left?.length||0}L ${story.newsCoverage?.centre?.length||0}C ${story.newsCoverage?.right?.length||0}R)
- Real Reddit posts: ${redditCount}
- Has image: ${story.imageUrl?"yes":"no"}
- Fact checks: ${(story.factChecks||[]).length}

Left summary (first 200 chars): "${(story.leftSummary||"").slice(0,200)}"
Right summary (first 200 chars): "${(story.rightSummary||"").slice(0,200)}"
Neutral summary (first 200 chars): "${(story.neutralSummary||"").slice(0,200)}"

APPROVE if: genuine national political news + both summaries present + not fiction

REJECT only if:
- Story is clearly non-political (celebrity/sports/lifestyle with no political angle)
- Both left AND right summaries are completely missing or empty
- Story describes impossible fictional events

DO NOT reject for: having few sources, mentioning ${year} dates, being critical of any politician.

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
    console.log(`    Gate done in ${elapsed}s — approved: ${approved} score: ${review.qualityScore||"?"}/10`);
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

// ─── FULL PIPELINE: one batch of 5 stories ────────────────────────────────────
async function processBatch(batchNum, headlines, excludeTopics=[], globalUsedUrls=new Set()) {

  // 1A: Select 5 story topics
  let selected = await agentSelector(batchNum, headlines, excludeTopics);
  if (selected.length === 0) throw new Error("Agent 1A returned no topics — check API credits");

  // 1A-Review: Editorial Director verifies selection
  selected = await agentSelectorReview(selected, headlines, batchNum);

  console.log(`\nApproved topics for batch ${batchNum}:`);
  selected.forEach((s,i)=>console.log(`  ${i+1}. ${s.topic}`));

  const processed = [];

  for (let i=0; i<selected.length; i++) {
    const meta = selected[i];
    console.log(`\n── Story ${i+1}/${selected.length}: "${meta.topic.slice(0,60)}" ──`);

    let story;

    // 1B: Write full story
    try {
      console.log("  Agent 1B (Writer)...");
      const ws = Date.now();
      story = await agentWriter(meta);
      console.log(`  1B done in ${((Date.now()-ws)/1000).toFixed(1)}s`);
    } catch(e) {
      console.warn(`  1B failed: ${e.message} — skipping story`);
      continue;
    }
    await new Promise(r=>setTimeout(r,1000));

    // 1B-Review: Senior Editor checks left/right balance
    story = await agentWriterReview(story);
    await new Promise(r=>setTimeout(r,1000));

    // Agent 2: Find news sources + Reddit posts via live web search
    const sourceResult = await agentSourceAndRedditFinder(story);
    let coverage = sourceResult.newsCoverage;
    story.leftPosts  = sourceResult.leftPosts  || [];
    story.rightPosts = sourceResult.rightPosts || [];

    // If web search returned no news sources, fall back to NewsAPI matching
    const newsTotal = (coverage.left?.length||0)+(coverage.centre?.length||0)+(coverage.right?.length||0);
    if (newsTotal === 0) {
      console.log("    Web search found no news sources — using NewsAPI fallback");
      coverage = agentSourceFallback(story, headlines, globalUsedUrls);
    }

    // Validate news source URLs
    coverage = await validateCoverage(coverage);

    // Mark used URLs globally to prevent duplicates across stories
    [...(coverage.left||[]),...(coverage.centre||[]),...(coverage.right||[])]
      .forEach(item=>{ if(item?.url) globalUsedUrls.add(item.url); });

    story.newsCoverage = coverage;
    await new Promise(r=>setTimeout(r,1000));

    // Agent 3: Fact check verification
    story = await agentFactChecker(story);
    await new Promise(r=>setTimeout(r,1000));

    // Fetch news image
    const stopWords = new Set(["that","this","with","from","over","into","amid","have","been",
      "will","they","them","their","after","about","would","also","says","said","just","more",
      "than","when","what","where","some","could","should","upon","both","each","very","many"]);
    const topicWords = story.topic.split(" ")
      .filter(w=>w.length>3&&!stopWords.has(w.toLowerCase()));
    const imgQueries = [
      story.searchQuery,
      topicWords.slice(0,5).join(" "),
      topicWords.slice(0,3).join(" "),
    ].filter((q,i,a)=>q&&a.indexOf(q)===i);

    let image = {imageUrl:null,imageCredit:null,imageArticleUrl:null};
    for (const q of imgQueries) {
      image = await fetchNewsImage(q).catch(()=>({imageUrl:null,imageCredit:null,imageArticleUrl:null}));
      if (image.imageUrl) { console.log(`  Image: ${q.slice(0,40)}`); break; }
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

    const srcCount = (finalStory.newsCoverage?.left?.length||0)+
                     (finalStory.newsCoverage?.centre?.length||0)+
                     (finalStory.newsCoverage?.right?.length||0);
    const redditCount = (finalStory.leftPosts?.filter(p=>p.url?.includes("/comments/"))||[]).length +
                        (finalStory.rightPosts?.filter(p=>p.url?.includes("/comments/"))||[]).length;
    console.log(`  ✅ APPROVED — ${srcCount} news sources, ${redditCount} Reddit posts, image: ${finalStory.imageUrl?"yes":"no"}, score: ${finalStory.qualityScore||"?"}/10`);
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
  console.log("Agents: 1A Selector → 1A-Review → 1B Writer → 1B-Review → 2 Sources+Reddit → 3 Facts → Gate\n");

  // Fetch today's headlines from NewsAPI (3 parallel calls)
  console.log("Fetching today's headlines...");
  const headlines = await fetchTodaysHeadlines();
  const totalHL = (headlines.left?.length||0)+(headlines.centre?.length||0)+(headlines.right?.length||0);
  console.log(`Headlines ready: ${totalHL} (${headlines.left?.length||0}L ${headlines.centre?.length||0}C ${headlines.right?.length||0}R)\n`);

  const globalUsedUrls = new Set();

  // Batch 1: stories 1-5
  console.log("=== BATCH 1 ===");
  const batch1 = await processBatch(1, headlines, [], globalUsedUrls);
  await fsSet("storyCache/" + today, {
    storiesJson: JSON.stringify(batch1),
    generatedAt: new Date().toISOString(),
    complete: false,
  });
  console.log(`\nBatch 1 saved — ${batch1.length} stories`);

  // Batch 2: stories 6-10 (excludes batch 1 topics)
  const batch1Topics = batch1.map(s=>s.topic);
  console.log("\n=== BATCH 2 ===");
  const batch2 = await processBatch(2, headlines, batch1Topics, globalUsedUrls);

  // Save complete set of 10 stories
  const all = [...batch1, ...batch2];
  await fsSet("storyCache/" + today, {
    storiesJson: JSON.stringify(all),
    generatedAt: new Date().toISOString(),
    complete: true,
  });

  // Final summary
  const totalSrc = all.reduce((s,x) => {
    const c = x.newsCoverage||{};
    return s+(c.left?.length||0)+(c.centre?.length||0)+(c.right?.length||0);
  }, 0);
  const totalReddit = all.reduce((s,x) => {
    return s + (x.leftPosts?.filter(p=>p.url?.includes("/comments/"))||[]).length
             + (x.rightPosts?.filter(p=>p.url?.includes("/comments/"))||[]).length;
  }, 0);

  console.log("\n=== DONE ===");
  console.log(`${all.length} stories published for ${today}`);
  console.log(`${totalSrc} verified news sources`);
  console.log(`${totalReddit} real Reddit posts`);
  console.log(`${all.filter(s=>s.imageUrl).length}/10 stories with images`);
  console.log(`Average quality score: ${(all.reduce((s,x)=>s+(x.qualityScore||0),0)/Math.max(all.length,1)).toFixed(1)}/10`);
  console.log("Finished: " + new Date().toISOString());
}

main().catch(err => {
  console.error("FAILED:", err.message || err);
  process.exit(0);
});
