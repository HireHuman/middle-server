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
async function fetchRedditPosts(searchQuery, topic) {
  console.log(`  Reddit: "${searchQuery}"`);
  const headers = { "User-Agent": "MIDDLE-App/1.0 (contact@themiddle.app)" };

  async function searchSub(sub, query) {
    try {
      const res = await fetch(
        `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&sort=top&t=week&limit=5`,
        { headers }
      );
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.data?.children || []).map(c => c.data).filter(p => p.score > 50);
    } catch(e) { return []; }
  }

  const leftSubs  = ["politics", "news", "worldnews", "progressive", "democrats"];
  const rightSubs = ["conservative", "Republican", "NeutralPolitics", "Libertarian", "PoliticsRight"];

  const [lr, rr] = await Promise.all([
    Promise.all(leftSubs.map(s => searchSub(s, searchQuery))),
    Promise.all(rightSubs.map(s => searchSub(s, searchQuery))),
  ]);

  const fmt = (posts, side) => posts
    .flat().sort((a,b) => b.score-a.score).slice(0,5)
    .map((p,i) => ({
      id: `${side[0]}${i+1}`,
      handle: `r/${p.subreddit}`, source: "Reddit",
      avatar: p.subreddit[0].toUpperCase(),
      text: p.title, likes: p.score, reposts: p.num_comments,
      url: `https://reddit.com${p.permalink}`, searchQuery,
      thread: p.selftext?.length > 10
        ? [{ avatar:"R", handle:`u/${p.author}`, text:p.selftext.slice(0,200), likes:Math.floor(p.score*0.3) }]
        : []
    }));

  let left  = fmt(lr, "left");
  let right = fmt(rr, "right");

  const pad = (arr, side, sub, url) => {
    while (arr.length < 3) arr.push({
      id:`${side[0]}${arr.length+1}`, handle:`r/${sub}`, source:"Reddit",
      avatar:sub[0].toUpperCase(), text:`Top Reddit discussions: ${topic}`,
      likes:0, reposts:0, url, searchQuery, thread:[]
    });
  };
  pad(left,  "left",  "politics",     `https://www.reddit.com/r/politics/search/?q=${encodeURIComponent(searchQuery)}&sort=top&t=week`);
  pad(right, "right", "conservative", `https://www.reddit.com/r/conservative/search/?q=${encodeURIComponent(searchQuery)}&sort=top&t=week`);

  console.log(`  Reddit: ${left.length}L ${right.length}R posts`);
  return { leftPosts: left, rightPosts: right };
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
        { role:"system", content:"You are editorial AI for MIDDLE. Live web access. Raw JSON array only. Start [ end ]." },
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

  const raw = text.slice(si, ei)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,"")
    .replace(/\t/g," ");

  const stories = JSON.parse(raw);
  console.log(`Batch ${batchNum}: ${stories.length} stories OK`);
  return stories;
}

async function enrichStory(story) {
  console.log(`\nEnriching: "${story.topic}"`);
  const query = story.searchQuery || story.topic;

  const [reddit, image] = await Promise.allSettled([
    fetchRedditPosts(query, story.topic),
    fetchNewsImage(query),
  ]);

  story.leftPosts       = reddit.status==="fulfilled" ? reddit.value.leftPosts  : [];
  story.rightPosts      = reddit.status==="fulfilled" ? reddit.value.rightPosts : [];
  story.imageUrl        = image.status==="fulfilled"  ? image.value.imageUrl        : null;
  story.imageCredit     = image.status==="fulfilled"  ? image.value.imageCredit     : null;
  story.imageArticleUrl = image.status==="fulfilled"  ? image.value.imageArticleUrl : null;

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
  for (const s of raw1) {
    batch1.push(await enrichStory(s));
    await new Promise(r => setTimeout(r, 2000));
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
  for (const s of raw2) {
    batch2.push(await enrichStory(s));
    await new Promise(r => setTimeout(r, 2000));
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
