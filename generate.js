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
  // Validate permalink -- Reddit returns relative paths like /r/sub/comments/id/title
  const permalink = p.permalink || "";
  const hasRealPermalink = permalink.includes("/comments/");
  const url = hasRealPermalink
    ? `https://www.reddit.com${permalink}`
    : null; // null means no real post found

  if (!hasRealPermalink) {
    console.log(`    WARNING: No permalink for post "${(p.title||"").slice(0,50)}" -- will be skipped`);
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

  // Format posts -- only keep ones with real permalinks
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

// ─── GROK API CALL (shared by all agents) ────────────────────────────────────
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
      timeout: 600000,
    };
    let data = "";
    const req = https.request(options, res => {
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Grok timeout")); });
    req.setTimeout(600000);
    req.write(body);
    req.end();
  });

  if (result.status !== 200) throw new Error(`Grok API ${result.status}: ${result.body.slice(0,200)}`);
  const parsed = JSON.parse(result.body);
  return parsed.choices?.[0]?.message?.content || "";
}

function parseJSON(text) {
  // Find JSON array or object
  const arrStart = text.indexOf("[");
  const objStart = text.indexOf("{");
  let start = -1;
  let end = -1;
  let isArray = false;

  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    start = arrStart; isArray = true;
    end = text.lastIndexOf("]") + 1;
  } else if (objStart !== -1) {
    start = objStart;
    end = text.lastIndexOf("}") + 1;
  }
  if (start === -1 || end === 0) throw new Error("No JSON found in response");

  let raw = text.slice(start, end)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/}(\s*){/g, '},$1{');

  try { return JSON.parse(raw); } catch(e) {
    // Aggressive fallback
    const stripped = raw.replace(/[^\x20-\x7E\x09\x0A\x0D]/g, " ")
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped);
  }
}

// ─── AGENT 1: STORY WRITER ────────────────────────────────────────────────────
// Writes 5 full stories per batch — left/right perspectives, fact checks,
// common ground, blindspot, Bird's-Eye View
async function agentWriter(batch) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday:"long", month:"long", day:"numeric", year:"numeric"
  });
  const batchInstr = batch === 1
    ? "Focus on the TOP 5 most-discussed political stories right now — the most covered across both left and right media."
    : "Focus on the NEXT 5 most-discussed political stories. Important but slightly below the top 5. Do NOT repeat batch 1 stories.";

  console.log(`\nAgent 1 (Writer) — batch ${batch}...`);
  const start = Date.now();

  const system = `You are the lead editorial writer for MIDDLE, a nonpartisan news app. You have live web access.
Your job: write 5 complete, deeply researched political stories.
CRITICAL JSON RULES: Return ONLY a raw JSON array. No markdown. No code fences. Start with [ end with ].
All strings must be properly escaped. No raw newlines inside strings. No trailing commas.`;

  const user = `Today is ${today}. ${batchInstr}

Return a JSON array of exactly 5 stories. Each story:
{
  "id": "unique-kebab-slug",
  "topic": "Specific headline with real names and stakes",
  "time": "Xh ago",
  "category": "POLITICS",
  "categoryColor": "#818cf8",
  "breaking": false,
  "searchQuery": "3-5 keywords for searching this story e.g. Trump tariffs China 2026",
  "neutralSummary": "3-4 factual sentences. Real names, numbers, dates.",
  "neutralDetail": "6-8 sentences of deep background and context.",
  "leftSummary": "3-4 sentences — the strongest honest progressive argument.",
  "rightSummary": "3-4 sentences — the strongest honest conservative argument.",
  "commonGround": ["Genuine shared value 1","Genuine shared value 2","Genuine shared value 3","Genuine shared value 4","Genuine shared value 5"],
  "conclusion": "3-4 paragraph Bird's-Eye View editorial. Where each side is right, where wrong, what both ignore.",
  "blindspotLeft": "1-2 sentences on what left-leaning media is NOT covering about this story.",
  "blindspotRight": "1-2 sentences on what right-leaning media is NOT covering about this story.",
  "factChecks": [
    {"claim":"A specific claim conservatives are ACTUALLY making right now","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences evidence.","likes":18400},
    {"claim":"A specific claim liberals are ACTUALLY making right now","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences evidence.","likes":14200},
    {"claim":"A specific claim conservatives are ACTUALLY making right now","side":"right","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences evidence.","likes":22800},
    {"claim":"A specific claim liberals are ACTUALLY making right now","side":"left","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences evidence.","likes":16400},
    {"claim":"A specific claim conservatives are ACTUALLY making right now","side":"right","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences evidence.","likes":11200},
    {"claim":"A specific claim liberals are ACTUALLY making right now","side":"left","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences evidence.","likes":19800},
    {"claim":"A specific claim conservatives are ACTUALLY making right now","side":"right","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences evidence.","likes":13400},
    {"claim":"A specific claim liberals are ACTUALLY making right now","side":"left","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences evidence.","likes":9800},
    {"claim":"A specific claim conservatives are ACTUALLY making right now","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences evidence.","likes":21200},
    {"claim":"A specific claim liberals are ACTUALLY making right now","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences evidence.","likes":12800}
  ],
  "leftPosts": [],
  "rightPosts": [],
  "newsCoverage": {"left":[],"centre":[],"right":[]}
}

Category colors: POLITICS=#818cf8 WORLD=#ef4444 ECONOMY=#10b981 JUSTICE=#f59e0b HEALTH=#06b6d4 CULTURE=#ec4899`;

  const text = await callGrok(system, user, 32000);
  const elapsed = ((Date.now()-start)/1000).toFixed(1);
  console.log(`Agent 1 done in ${elapsed}s`);
  const stories = parseJSON(text);
  console.log(`Agent 1: ${stories.length} stories written`);
  return stories;
}

// ─── AGENT 2: SOURCE FINDER ───────────────────────────────────────────────────
// For each story, finds real news article URLs from left/centre/right outlets
async function agentSourceFinder(story) {
  console.log(`  Agent 2 (Sources) — "${story.topic.slice(0,50)}"`);
  const start = Date.now();

  const system = `You are a research assistant for MIDDLE news app. You have live web access.
Your ONLY job: find real, working news article URLs about a specific story.
Return ONLY a raw JSON object. No markdown. No commentary.
CRITICAL: Every URL must be a real article you found via web search. Never invent URLs.`;

  const user = `Search the web right now for news articles about this story:
"${story.topic}"

Search query: "${story.searchQuery}"

Find real articles from these outlets if they covered this story:

LEFT: CNN, MSNBC, New York Times, Washington Post, The Guardian, NPR, HuffPost, Vox, The Atlantic, Politico
CENTRE: Reuters, Associated Press, BBC, Axios, The Hill, Bloomberg, Newsweek, USA Today
RIGHT: Fox News, New York Post, Wall Street Journal, Washington Examiner, Daily Wire, Breitbart, National Review, Daily Caller, Newsmax

Return this JSON:
{
  "left": [
    {"outlet":"CNN","url":"https://cnn.com/REAL-ARTICLE-PATH","headline":"Exact headline from the article","bias":"left"}
  ],
  "centre": [
    {"outlet":"Reuters","url":"https://reuters.com/REAL-ARTICLE-PATH","headline":"Exact headline","bias":"centre"}
  ],
  "right": [
    {"outlet":"Fox News","url":"https://foxnews.com/REAL-ARTICLE-PATH","headline":"Exact headline","bias":"right"}
  ]
}

Rules:
- Only include outlets that ACTUALLY published an article about this specific story
- Every URL must be real and working — you found it via web search
- Include the exact article headline
- Aim for 3-5 outlets per category where available
- If an outlet did not cover this story, omit it entirely
- Do NOT invent or guess URLs`;

  try {
    const text = await callGrok(system, user, 8000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const coverage = parseJSON(text);
    const total = (coverage.left?.length||0)+(coverage.centre?.length||0)+(coverage.right?.length||0);
    console.log(`    Agent 2 done in ${elapsed}s — ${total} sources found`);
    return coverage;
  } catch(e) {
    console.warn(`    Agent 2 failed: ${e.message}`);
    return { left:[], centre:[], right:[] };
  }
}

// ─── AGENT 3: VERIFIER ────────────────────────────────────────────────────────
// Reviews the complete story for accuracy, balance, and correct fact check sides
async function agentVerifier(story) {
  console.log(`  Agent 3 (Verifier) — "${story.topic.slice(0,50)}"`);
  const start = Date.now();

  const system = `You are a senior editorial fact-checker for MIDDLE, a nonpartisan news app. You have live web access.
Your job: review a completed story and fix any errors.
Return ONLY a raw JSON object with corrections. No markdown.`;

  const user = `Review this story for MIDDLE and fix any problems:

Topic: "${story.topic}"

Left summary: "${story.leftSummary}"
Right summary: "${story.rightSummary}"

Fact checks to verify:
${story.factChecks.map((fc,i) => `${i+1}. [${fc.side}] "${fc.claim}" — verdict: ${fc.verdict}`).join('\n')}

Check for these specific issues:
1. FACT CHECK SIDES: Is each claim actually being made by the side it's assigned to? 
   A "right" claim must be something conservatives are actually saying. 
   A "left" claim must be something liberals are actually saying.
2. VERDICTS: Are the TRUE/FALSE/MISLEADING/UNVERIFIED verdicts accurate?
3. BALANCE: Is the left summary genuinely the strongest progressive argument? Is the right summary genuinely the strongest conservative argument?

Return a JSON object:
{
  "approved": true,
  "corrections": {
    "factChecks": [
      {
        "index": 0,
        "field": "side",
        "oldValue": "right",
        "newValue": "left",
        "reason": "This claim is actually being made by the left"
      }
    ],
    "leftSummary": null,
    "rightSummary": null
  },
  "notes": "Brief overall assessment"
}

If everything looks correct set "approved": true and empty corrections arrays.
Only fix genuine errors — do not change things that are accurate.`;

  try {
    const text = await callGrok(system, user, 4000);
    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const review = parseJSON(text);
    console.log(`    Agent 3 done in ${elapsed}s — approved: ${review.approved}`);

    // Apply corrections if any
    if (review.corrections?.factChecks?.length > 0) {
      for (const fix of review.corrections.factChecks) {
        if (fix.index >= 0 && fix.index < story.factChecks.length) {
          console.log(`    Fixing factCheck[${fix.index}] ${fix.field}: ${fix.oldValue} → ${fix.newValue}`);
          story.factChecks[fix.index][fix.field] = fix.newValue;
          // Update color if side changed
          if (fix.field === "side") {
            const fc = story.factChecks[fix.index];
            if (fix.newValue === "left")  fc.color = fc.color; // keep existing verdict color
            if (fix.newValue === "right") fc.color = fc.color;
          }
        }
      }
    }
    if (review.corrections?.leftSummary)  story.leftSummary  = review.corrections.leftSummary;
    if (review.corrections?.rightSummary) story.rightSummary = review.corrections.rightSummary;
    story.verifierNotes = review.notes || "";
    return story;
  } catch(e) {
    console.warn(`    Agent 3 failed: ${e.message} — using original`);
    return story;
  }
}

// ─── FULL PIPELINE: Writer → Sources → Verify → Image ────────────────────────
async function processBatch(batchNum) {
  // Step 1: Write all 5 stories
  const stories = await agentWriter(batchNum);

  // Step 2: For each story, find sources + verify + get image
  // Run source finding and verification in sequence per story
  // (parallel would be too many simultaneous Grok calls)
  const processed = [];
  for (let i = 0; i < stories.length; i++) {
    let story = stories[i];
    console.log(`\nProcessing story ${i+1}/${stories.length}: "${story.topic.slice(0,50)}"`);

    // Agent 2: Find real news sources
    story.newsCoverage = await agentSourceFinder(story);
    await new Promise(r => setTimeout(r, 1000));

    // Agent 3: Verify and fix errors
    story = await agentVerifier(story);
    await new Promise(r => setTimeout(r, 1000));

    // Validate source URLs
    if (story.newsCoverage) {
      story.newsCoverage = await validateCoverage(story.newsCoverage);
    }

    // Get news image
    const imageDelay = i * 3000;
    if (imageDelay > 0) await new Promise(r => setTimeout(r, imageDelay));
    const imageQueries = [story.searchQuery, story.topic.split(" ").slice(0,4).join(" ")].filter(Boolean);
    let image = { imageUrl:null, imageCredit:null, imageArticleUrl:null };
    for (const q of imageQueries) {
      image = await fetchNewsImage(q).catch(() => ({ imageUrl:null, imageCredit:null, imageArticleUrl:null }));
      if (image.imageUrl) { console.log(`  Image found`); break; }
      await new Promise(r => setTimeout(r, 800));
    }
    story.imageUrl        = image.imageUrl;
    story.imageCredit     = image.imageCredit;
    story.imageArticleUrl = image.imageArticleUrl;

    const coverage = story.newsCoverage;
    const srcCount = (coverage?.left?.length||0)+(coverage?.centre?.length||0)+(coverage?.right?.length||0);
    console.log(`  Story complete — ${srcCount} verified sources, image: ${story.imageUrl ? 'yes':'no'}`);
    processed.push(story);
  }
  return processed;
}


async function main() {
  console.log("=== MIDDLE Story Generator -- 3-Agent Pipeline ===");
  console.log("Started at: " + new Date().toISOString());
  if (!GROK_API_KEY) throw new Error("GROK_API_KEY not set");

  const today = new Date().toISOString().slice(0,10);
  console.log("Date: " + today);
  console.log("Pipeline: Writer > Source Finder > Verifier > Image");

  // Batch 1 through full pipeline
  console.log("\n=== BATCH 1 ===");
  const batch1 = await processBatch(1);

  await fsSet("storyCache/" + today, {
    storiesJson: JSON.stringify(batch1),
    generatedAt: new Date().toISOString(),
    complete: false,
  });
  console.log("Batch 1 saved -- " + batch1.length + " stories");

  // Batch 2
  console.log("\n=== BATCH 2 ===");
  const batch2 = await processBatch(2);

  const all = [...batch1, ...batch2];
  await fsSet("storyCache/" + today, {
    storiesJson: JSON.stringify(all),
    generatedAt: new Date().toISOString(),
    complete: true,
  });

  const totalSources = all.reduce((sum, s) => {
    const c = s.newsCoverage||{};
    return sum + (c.left?.length||0) + (c.centre?.length||0) + (c.right?.length||0);
  }, 0);
  const withImages = all.filter(s => s.imageUrl).length;

  console.log("\n Done!");
  console.log("  " + all.length + " stories saved for " + today);
  console.log("  " + totalSources + " verified news sources");
  console.log("  " + withImages + "/10 stories with images");
  console.log("Finished: " + new Date().toISOString());
}
main().catch(err => {
  console.error("❌ Failed:", err.message || err);
  // Exit with code 0 so Railway doesn't immediately restart
  // A cron job should not retry on failure -- wait for next scheduled run
  process.exit(0);
});
