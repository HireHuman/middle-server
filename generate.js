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
const LEFT_SUBS  = ["politics","news","worldnews","progressive","democrats","Liberal","PoliticalDiscussion","uspolitics"];
const RIGHT_SUBS = ["conservative","Republican","AskConservatives","Libertarian","republicans","PoliticsRight","ConservativeOnly"];

const REDDIT_HEADERS = { "User-Agent": "MIDDLE-NewsApp/1.0 (by /u/middle_app)" };

async function searchRedditSub(sub, query) {
  // Try two approaches: subreddit search AND hot/new posts
  const urls = [
    `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=year&limit=25&restrict_sr=on`,
    `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&sort=top&t=year&limit=25&restrict_sr=on`,
  ];

  const posts = [];
  const seen = new Set();

  for (const url of urls) {
    try {
      await new Promise(r => setTimeout(r, 300)); // be polite to Reddit
      const res = await fetch(url, { headers: REDDIT_HEADERS });
      if (!res.ok) {
        console.log(`    r/${sub}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const children = (data?.data?.children || []).map(c => c.data);
      console.log(`    r/${sub}: ${children.length} posts`);
      for (const p of children) {
        if (p && p.id && !seen.has(p.id) && p.title) {
          seen.add(p.id);
          posts.push(p);
        }
      }
    } catch(e) {
      console.log(`    r/${sub}: error ${e.message}`);
    }
  }
  return posts;
}

function formatRedditPost(p, side, index) {
  // Validate permalink — Reddit returns relative paths like /r/sub/comments/id/title
  const permalink = p.permalink || "";
  const hasRealPermalink = permalink.includes("/comments/");
  const url = hasRealPermalink
    ? `https://www.reddit.com${permalink}`
    : null; // null means no real post found

  if (!hasRealPermalink) {
    console.log(`    WARNING: No permalink for post "${(p.title||"").slice(0,50)}" — will be skipped`);
  }

  return {
    id: `${side[0]}${index+1}`,
    handle: `r/${p.subreddit}`,
    source: "Reddit",
    avatar: (p.subreddit||"R")[0].toUpperCase(),
    text: p.title || "",
    likes: p.score || 0,
    reposts: p.num_comments || 0,
    url: url,
    hasRealUrl: hasRealPermalink,
    searchQuery: p._query || "",
    thread: p.selftext && p.selftext.length > 30
      ? [{ avatar:"R", handle:`u/${p.author}`, text:p.selftext.slice(0,300), likes:Math.floor((p.score||1)*0.2) }]
      : []
  };
}

async function fetchRedditPosts(searchQuery, topic) {
  console.log(`  Reddit: "${searchQuery}"`);

  // Fetch left and right subs completely independently
  const leftResults  = await Promise.all(LEFT_SUBS.map(s => searchRedditSub(s, searchQuery)));
  const rightResults = await Promise.all(RIGHT_SUBS.map(s => searchRedditSub(s, searchQuery)));

  // Flatten, tag with query, dedupe, sort by score
  function process(results) {
    const seen = new Set();
    return results
      .flat()
      .filter(p => {
        if (!p || !p.id || !p.title) return false;
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      })
      .map(p => ({ ...p, _query: searchQuery }))
      .sort((a,b) => (b.score||0) - (a.score||0));
  }

  const leftAll  = process(leftResults);
  const rightAll = process(rightResults);

  console.log(`  Reddit left: ${leftAll.length} unique posts`);
  console.log(`  Reddit right: ${rightAll.length} unique posts`);

  // Format posts — only keep ones with real permalinks
  const leftFormatted  = leftAll.map((p,i)  => formatRedditPost(p, "left",  i)).filter(p => p.hasRealUrl);
  const rightFormatted = rightAll.map((p,i) => formatRedditPost(p, "right", i)).filter(p => p.hasRealUrl);

  console.log(`  Reddit left with real URLs: ${leftFormatted.length}`);
  console.log(`  Reddit right with real URLs: ${rightFormatted.length}`);

  let leftPosts  = leftFormatted.slice(0, 5);
  let rightPosts = rightFormatted.slice(0, 5);

  // Pad only if truly nothing found
  const leftFallbackUrl  = `https://www.reddit.com/r/politics/search/?q=${encodeURIComponent(searchQuery)}&sort=top&t=year`;
  const rightFallbackUrl = `https://www.reddit.com/r/conservative/search/?q=${encodeURIComponent(searchQuery)}&sort=top&t=year`;

  while (leftPosts.length < 5) {
    leftPosts.push({
      id:`l${leftPosts.length+1}`, handle:"r/politics", source:"Reddit", avatar:"P",
      text:`Reddit: ${topic}`, likes:0, reposts:0, url:leftFallbackUrl, searchQuery, thread:[]
    });
  }
  while (rightPosts.length < 5) {
    rightPosts.push({
      id:`r${rightPosts.length+1}`, handle:"r/conservative", source:"Reddit", avatar:"C",
      text:`Reddit: ${topic}`, likes:0, reposts:0, url:rightFallbackUrl, searchQuery, thread:[]
    });
  }

  const lReal = leftPosts.filter(p=>p.likes>0).length;
  const rReal = rightPosts.filter(p=>p.likes>0).length;
  console.log(`  Reddit final: ${lReal}/5 real left, ${rReal}/5 real right`);

  return { leftPosts, rightPosts };
}

// ─── Image ────────────────────────────────────────────────────────────────────
async function fetchNewsImage(searchQuery) {
  if (NEWS_API_KEY) {
    try {
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(searchQuery)}&sortBy=relevancy&pageSize=10&language=en&apiKey=${NEWS_API_KEY}`;
      console.log(`  NewsAPI: fetching "${searchQuery}"`);
      const res = await fetch(url);
      const status = res.status;
      console.log(`  NewsAPI status: ${status}`);
      if (res.ok) {
        const data = await res.json();
        console.log(`  NewsAPI articles: ${data.articles?.length || 0}`);
        const a = (data.articles||[]).find(a =>
          a.urlToImage &&
          !a.urlToImage.includes("placeholder") &&
          !a.urlToImage.includes("none") &&
          a.urlToImage.startsWith("http")
        );
        if (a) {
          console.log(`  NewsAPI image found: ${a.urlToImage.slice(0,60)}`);
          return { imageUrl: a.urlToImage, imageCredit: a.source?.name||"News", imageArticleUrl: a.url };
        } else {
          console.log(`  NewsAPI: no valid image in results`);
        }
      } else {
        const body = await res.text();
        console.log(`  NewsAPI error body: ${body.slice(0,100)}`);
      }
    } catch(e) { console.log(`  NewsAPI exception: ${e.message}`); }
  } else {
    console.log("  NewsAPI: no key configured");
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
"redditKeywords": array of 3-5 individual keywords that are most likely to find Reddit posts e.g. ["Trump", "tariffs", "China", "trade"].

JSON shape:
[{
  "id":"kebab-slug",
  "topic":"Specific headline with names",
  "time":"Xh ago",
  "category":"POLITICS",
  "categoryColor":"#818cf8",
  "breaking":false,
  "searchQuery":"specific search terms",
  "redditKeywords":["keyword1","keyword2","keyword3"],
  "neutralSummary":"3-4 factual sentences.",
  "neutralDetail":"6-8 sentences background.",
  "leftSummary":"3-4 sentences progressive argument.",
  "rightSummary":"3-4 sentences conservative argument.",
  "commonGround":["value1","value2","value3","value4","value5"],
  "conclusion":"3-4 paragraph Birds Eye View editorial.",
  "factChecks":[
    {"claim":"A specific factual claim that conservatives or right-leaning media ARE ACTUALLY MAKING about this story","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences of evidence supporting or refuting this claim.","likes":18400},
    {"claim":"A specific factual claim that liberals or left-leaning media ARE ACTUALLY MAKING about this story","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences of evidence.","likes":14200},
    {"claim":"A specific factual claim that conservatives or right-leaning media ARE ACTUALLY MAKING about this story","side":"right","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences of evidence.","likes":22800},
    {"claim":"A specific factual claim that liberals or left-leaning media ARE ACTUALLY MAKING about this story","side":"left","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences of evidence.","likes":16400},
    {"claim":"A specific factual claim that conservatives or right-leaning media ARE ACTUALLY MAKING about this story","side":"right","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences of evidence.","likes":11200},
    {"claim":"A specific factual claim that liberals or left-leaning media ARE ACTUALLY MAKING about this story","side":"left","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences of evidence.","likes":19800},
    {"claim":"A specific factual claim that conservatives or right-leaning media ARE ACTUALLY MAKING about this story","side":"right","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences of evidence.","likes":13400},
    {"claim":"A specific factual claim that liberals or left-leaning media ARE ACTUALLY MAKING about this story","side":"left","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences of evidence.","likes":9800},
    {"claim":"A specific factual claim that conservatives or right-leaning media ARE ACTUALLY MAKING about this story","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences of evidence.","likes":21200},
    {"claim":"A specific factual claim that liberals or left-leaning media ARE ACTUALLY MAKING about this story","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences of evidence.","likes":12800}
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
        { role:"system", content:"You are editorial AI for MIDDLE. You have live web access. CRITICAL: Respond with a raw JSON array ONLY. No markdown, no code fences, no commentary. Start immediately with [ and end with ]. Ensure all strings are properly escaped. Never use unescaped newlines, tabs, or quotes inside string values. Every object must have all required fields. Validate your JSON is complete before responding. FACT CHECK RULES: side=right means the claim is one that conservatives/right-leaning people are making. side=left means the claim is one that liberals/left-leaning people are making. Never assign a claim to the wrong side. Each claim must be something that side is ACTUALLY saying in the current news cycle." },
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

async function enrichStory(story, storyIndex=0) {
  console.log(`\nEnriching story ${storyIndex+1}: "${story.topic}"`);

  // Build best Reddit search query from Grok-provided keywords
  // Use redditKeywords if available, otherwise fall back to searchQuery
  const redditQuery = story.redditKeywords && story.redditKeywords.length > 0
    ? story.redditKeywords.slice(0, 4).join(" ")
    : story.searchQuery || story.topic.split(" ").slice(0, 5).join(" ");

  // Also build a date-aware query — add current year to help find recent posts
  const year = new Date().getFullYear();
  const timedQuery = `${redditQuery} ${year}`;

  console.log(`  Search query: "${redditQuery}"`);
  console.log(`  Timed query:  "${timedQuery}"`);

  // Fetch Reddit posts using both queries and merge results
  const [reddit1, reddit2] = await Promise.allSettled([
    fetchRedditPosts(redditQuery, story.topic),
    fetchRedditPosts(timedQuery,  story.topic),
  ]);

  // Merge left and right posts from both queries, dedupe by id
  function mergePosts(r1, r2, side) {
    const seen = new Set();
    const all = [
      ...(r1.status==="fulfilled" ? r1.value[side] : []),
      ...(r2.status==="fulfilled" ? r2.value[side] : []),
    ].filter(p => {
      if (!p.likes || seen.has(p.url)) return false; // skip fallback links + dupes
      seen.add(p.url);
      return true;
    });
    return all.sort((a,b) => b.likes - a.likes).slice(0, 5);
  }

  let leftPosts  = mergePosts(reddit1, reddit2, "leftPosts");
  let rightPosts = mergePosts(reddit1, reddit2, "rightPosts");

  // If we still don't have 5 real posts, try one more search with just the topic keywords
  if (leftPosts.length < 3 || rightPosts.length < 3) {
    const topicWords = story.topic.split(" ")
      .filter(w => w.length > 4)
      .slice(0, 4)
      .join(" ");
    console.log(`  Fallback topic query: "${topicWords}"`);
    const reddit3 = await fetchRedditPosts(topicWords, story.topic)
      .catch(() => ({ leftPosts:[], rightPosts:[] }));

    if (leftPosts.length < 3) {
      const extra = (reddit3.leftPosts||[]).filter(p => p.likes > 0);
      leftPosts = [...leftPosts, ...extra].slice(0, 5);
    }
    if (rightPosts.length < 3) {
      const extra = (reddit3.rightPosts||[]).filter(p => p.likes > 0);
      rightPosts = [...rightPosts, ...extra].slice(0, 5);
    }
  }

  // Pad to 5 with search links if still not enough
  const sq = encodeURIComponent(redditQuery);
  while (leftPosts.length < 5) {
    leftPosts.push({
      id:`l${leftPosts.length+1}`, handle:"r/politics", source:"Reddit", avatar:"P",
      text:`Browse Reddit: ${story.topic}`, likes:0, reposts:0,
      url:`https://www.reddit.com/r/politics/search/?q=${sq}&sort=top&t=year`,
      searchQuery:redditQuery, thread:[]
    });
  }
  while (rightPosts.length < 5) {
    rightPosts.push({
      id:`r${rightPosts.length+1}`, handle:"r/conservative", source:"Reddit", avatar:"C",
      text:`Browse Reddit: ${story.topic}`, likes:0, reposts:0,
      url:`https://www.reddit.com/r/conservative/search/?q=${sq}&sort=top&t=year`,
      searchQuery:redditQuery, thread:[]
    });
  }

  story.leftPosts  = leftPosts;
  story.rightPosts = rightPosts;

  const lReal = leftPosts.filter(p=>p.likes>0).length;
  const rReal = rightPosts.filter(p=>p.likes>0).length;
  console.log(`  Reddit result: ${lReal}/5 real left, ${rReal}/5 real right`);

  // Stagger image requests — 4 seconds between each story to avoid NewsAPI rate limit
  const imageDelay = storyIndex * 4000;
  if (imageDelay > 0) {
    console.log(`  Waiting ${imageDelay/1000}s before image fetch...`);
    await new Promise(r => setTimeout(r, imageDelay));
  }

  // Try multiple image search queries for better results
  const imageQueries = [
    story.searchQuery,
    redditQuery,
    story.topic.split(" ").slice(0,4).join(" "),
  ];

  let image = { imageUrl:null, imageCredit:null, imageArticleUrl:null };
  for (const q of imageQueries) {
    image = await fetchNewsImage(q).catch(() => ({ imageUrl:null, imageCredit:null, imageArticleUrl:null }));
    if (image.imageUrl) {
      console.log(`  Image found with query: "${q}"`);
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  story.imageUrl        = image.imageUrl;
  story.imageCredit     = image.imageCredit;
  story.imageArticleUrl = image.imageArticleUrl;

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
    batch1.push(await enrichStory(raw1[i], i));
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
    batch2.push(await enrichStory(raw2[i], i));
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
  console.error("❌ Failed:", err.message || err);
  // Exit with code 0 so Railway doesn't immediately restart
  // A cron job should not retry on failure — wait for next scheduled run
  process.exit(0);
});
