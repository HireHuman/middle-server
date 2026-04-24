// ─── MIDDLE Story Generator ───────────────────────────────────────────────────
// Runs daily on Railway. Calls grok-3, fetches Reddit posts + news images,
// saves everything to Firestore.
// ─────────────────────────────────────────────────────────────────────────────

const GROK_API_KEY   = process.env.GROK_API_KEY;
const NEWS_API_KEY   = process.env.NEWS_API_KEY; // newsapi.org — free tier
const FB_PROJECT     = process.env.FB_PROJECT || "themiddle-85852";
const FB_API_KEY     = process.env.FB_API_KEY  || "AIzaSyBxAzJ0bVpOb2hux5OIylBngUDr0ZoH-w4";
const FB_BASE        = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

// ─── Firestore REST helpers ───────────────────────────────────────────────────
async function fsSet(path, obj) {
  const body = { fields: encodeFields(obj) };
  const res = await fetch(`${FB_BASE}/${path}?key=${FB_API_KEY}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

// ─── Reddit fetcher ───────────────────────────────────────────────────────────
async function fetchRedditPosts(searchQuery, topic) {
  console.log(`  Reddit: fetching posts for "${searchQuery}"`);

  const leftSubreddits  = ["politics", "news", "worldnews", "progressive", "democrats"];
  const rightSubreddits = ["conservative", "Republican", "NeutralPolitics", "PoliticsRight", "Libertarian"];

  const headers = {
    "User-Agent": "MIDDLE-App/1.0 (news aggregator; contact@themiddle.app)"
  };

  async function searchSubreddit(subreddit, query) {
    try {
      const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&sort=top&t=week&limit=5`;
      const res = await fetch(url, { headers });
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.data?.children || []).map(c => c.data).filter(p => p.score > 50);
    } catch(e) {
      console.warn(`  Reddit r/${subreddit} failed:`, e.message);
      return [];
    }
  }

  const leftResults  = await Promise.all(leftSubreddits.map(s => searchSubreddit(s, searchQuery)));
  const rightResults = await Promise.all(rightSubreddits.map(s => searchSubreddit(s, searchQuery)));

  const leftPosts  = leftResults.flat().sort((a,b) => b.score - a.score).slice(0, 5);
  const rightPosts = rightResults.flat().sort((a,b) => b.score - a.score).slice(0, 5);

  function formatPost(post, side, index) {
    return {
      id: `${side[0]}${index+1}`,
      handle: `r/${post.subreddit}`,
      source: "Reddit",
      avatar: post.subreddit[0].toUpperCase(),
      text: post.title,
      likes: post.score,
      reposts: post.num_comments,
      url: `https://reddit.com${post.permalink}`,
      searchQuery: searchQuery,
      thread: post.selftext && post.selftext.length > 10
        ? [{ avatar: "R", handle: `u/${post.author}`, text: post.selftext.slice(0, 200), likes: Math.floor(post.score * 0.3) }]
        : []
    };
  }

  let formattedLeft  = leftPosts.map((p,i)  => formatPost(p, "left",  i));
  let formattedRight = rightPosts.map((p,i) => formatPost(p, "right", i));

  // Pad with search links if not enough real posts
  const leftFallback = {
    id: `l${formattedLeft.length+1}`, handle: "r/politics", source: "Reddit", avatar: "P",
    text: `See top Reddit discussions about this story`,
    likes: 0, reposts: 0,
    url: `https://www.reddit.com/r/politics/search/?q=${encodeURIComponent(searchQuery)}&sort=top&t=week`,
    searchQuery, thread: []
  };
  const rightFallback = {
    id: `r${formattedRight.length+1}`, handle: "r/conservative", source: "Reddit", avatar: "C",
    text: `See top Reddit discussions about this story`,
    likes: 0, reposts: 0,
    url: `https://www.reddit.com/r/conservative/search/?q=${encodeURIComponent(searchQuery)}&sort=top&t=week`,
    searchQuery, thread: []
  };

  while (formattedLeft.length < 3)  formattedLeft.push({...leftFallback,  id: `l${formattedLeft.length+1}`});
  while (formattedRight.length < 3) formattedRight.push({...rightFallback, id: `r${formattedRight.length+1}`});

  console.log(`  Reddit: ${formattedLeft.length} left, ${formattedRight.length} right posts`);
  return { leftPosts: formattedLeft, rightPosts: formattedRight };
}

// ─── News image fetcher ───────────────────────────────────────────────────────
async function fetchNewsImage(searchQuery) {
  console.log(`  Image: fetching for "${searchQuery}"`);

  // Try NewsAPI first
  if (NEWS_API_KEY) {
    try {
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(searchQuery)}&sortBy=relevancy&pageSize=5&language=en&apiKey=${NEWS_API_KEY}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const articles = (data.articles || []).filter(a =>
          a.urlToImage &&
          !a.urlToImage.includes("placeholder") &&
          !a.urlToImage.includes("default")
        );
        if (articles.length > 0) {
          console.log(`  Image: found via NewsAPI`);
          return {
            imageUrl: articles[0].urlToImage,
            imageCredit: articles[0].source?.name || "News",
            imageArticleUrl: articles[0].url,
          };
        }
      }
    } catch(e) { console.warn("  NewsAPI failed:", e.message); }
  }

  // Fallback — Wikipedia
  try {
    const terms = searchQuery.split(" ").slice(0, 3).join("_");
    const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(terms)}`;
    const res = await fetch(wikiUrl);
    if (res.ok) {
      const data = await res.json();
      if (data.thumbnail?.source) {
        console.log(`  Image: found via Wikipedia`);
        return {
          imageUrl: data.thumbnail.source,
          imageCredit: "Wikipedia",
          imageArticleUrl: data.content_urls?.desktop?.page || "",
        };
      }
    }
  } catch(e) { console.warn("  Wikipedia failed:", e.message); }

  console.log(`  Image: none found`);
  return { imageUrl: null, imageCredit: null, imageArticleUrl: null };
}

// ─── Story prompt ─────────────────────────────────────────────────────────────
function buildPrompt(batch) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });

  const batchInstructions = batch === 1
    ? "Focus on the TOP 5 most-discussed political stories right now."
    : "Focus on the NEXT 5 most-discussed political stories. Do NOT repeat stories from batch 1.";

  return `You are the lead editorial writer for "The Middle" — a nonpartisan news app. Today is ${today}.

Search the web for the 5 most-discussed political stories RIGHT NOW. ${batchInstructions}

Return ONLY a raw JSON array. No markdown, no code fences. Start with [ end with ].

Include a "searchQuery" field per story — 3-5 specific keywords for searching Reddit (include names, bill names, key terms).

JSON shape for each story:
{
  "id": "unique-kebab-slug",
  "topic": "Specific headline with names and stakes",
  "time": "Xh ago",
  "category": "POLITICS",
  "categoryColor": "#818cf8",
  "breaking": false,
  "searchQuery": "specific search terms e.g. Trump tariffs China trade 2026",
  "neutralSummary": "3-4 factual sentences.",
  "neutralDetail": "6-8 sentences of deep background.",
  "leftSummary": "3-4 sentences — strongest progressive argument.",
  "rightSummary": "3-4 sentences — strongest conservative argument.",
  "commonGround": ["Shared value 1","Shared value 2","Shared value 3","Shared value 4","Shared value 5"],
  "conclusion": "3-4 paragraph Bird's-Eye View editorial.",
  "factChecks": [
    {"claim":"Right claim 1","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences.","likes":18400},
    {"claim":"Left claim 1","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences.","likes":14200},
    {"claim":"Right claim 2","side":"right","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences.","likes":22800},
    {"claim":"Left claim 2","side":"left","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences.","likes":16400},
    {"claim":"Right claim 3","side":"right","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences.","likes":11200},
    {"claim":"Left claim 3","side":"left","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences.","likes":19800},
    {"claim":"Right claim 4","side":"right","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences.","likes":13400},
    {"claim":"Left claim 4","side":"left","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences.","likes":9800},
    {"claim":"Right claim 5","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences.","likes":21200},
    {"claim":"Left claim 5","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences.","likes":12800}
  ],
  "leftPosts": [],
  "rightPosts": []
}

Category colors: POLITICS=#818cf8, WORLD=#ef4444, ECONOMY=#10b981, JUSTICE=#f59e0b, HEALTH=#06b6d4, CULTURE=#ec4899
Generate exactly 5 stories.`;
}

// ─── Call Grok ────────────────────────────────────────────────────────────────
async function fetchBatch(batchNum) {
  console.log(`\nCalling Grok for batch ${batchNum}...`);
  const start = Date.now();

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "grok-3",
      max_tokens: 32000,
      messages: [
        { role: "system", content: "You are the lead editorial AI for MIDDLE. You have live web access. Respond with a raw JSON array only. No markdown, no code fences. Start with [ end with ]." },
        { role: "user", content: buildPrompt(batchNum) },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Grok API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Batch ${batchNum} received in ${elapsed}s (${text.length} chars)`);

  const startIdx = text.indexOf("[");
  const endIdx   = text.lastIndexOf("]") + 1;
  if (startIdx === -1 || endIdx === 0) throw new Error("No JSON array in response");

  const raw = text.slice(startIdx, endIdx)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\t/g, " ");

  const stories = JSON.parse(raw);
  console.log(`Batch ${batchNum}: ${stories.length} stories parsed OK`);
  return stories;
}

// ─── Enrich story with Reddit + image ────────────────────────────────────────
async function enrichStory(story) {
  console.log(`\nEnriching: "${story.topic}"`);
  const query = story.searchQuery || story.topic;

  const [redditData, imageData] = await Promise.allSettled([
    fetchRedditPosts(query, story.topic),
    fetchNewsImage(query),
  ]);

  story.leftPosts  = redditData.status === "fulfilled" ? redditData.value.leftPosts  : [];
  story.rightPosts = redditData.status === "fulfilled" ? redditData.value.rightPosts : [];
  story.imageUrl        = imageData.status === "fulfilled" ? imageData.value.imageUrl        : null;
  story.imageCredit     = imageData.status === "fulfilled" ? imageData.value.imageCredit     : null;
  story.imageArticleUrl = imageData.status === "fulfilled" ? imageData.value.imageArticleUrl : null;

  return story;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== MIDDLE Story Generator ===");
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`NewsAPI: ${NEWS_API_KEY ? "configured" : "not set — Wikipedia fallback"}`);

  if (!GROK_API_KEY) throw new Error("GROK_API_KEY not set");

  const today = new Date().toISOString().slice(0, 10);
  console.log(`Generating stories for: ${today}`);

  // Batch 1
  const batch1Raw = await fetchBatch(1);
  console.log("\nEnriching batch 1...");
  const batch1 = [];
  for (const story of batch1Raw) {
    batch1.push(await enrichStory(story));
    await new Promise(r => setTimeout(r, 2000));
  }

  // Save batch 1 immediately so app shows content faster
  console.log("\nSaving batch 1...");
  await fsSet(`storyCache/${today}`, {
    storiesJson: JSON.stringify(batch1),
    generatedAt: new Date().toISOString(),
    complete: false,
  });
  console.log("Batch 1 saved.");

  // Batch 2
  const batch2Raw = await fetchBatch(2);
  console.log("\nEnriching batch 2...");
  const batch2 = [];
  for (const story of batch2Raw) {
    batch2.push(await enrichStory(story));
    await new Promise(r => setTimeout(r, 2000));
  }

  // Save all 10
  const allStories = [...batch1, ...batch2];
  console.log(`\nSaving all ${allStories.length} stories...`);
  await fsSet(`storyCache/${today}`, {
    storiesJson: JSON.stringify(allStories),
    generatedAt: new Date().toISOString(),
    complete: true,
  });

  console.log(`\n✅ Done! ${allStories.length} stories saved for ${today}`);
  console.log(`Finished at: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error("❌ Generator failed:", err);
  process.exit(1);
});
