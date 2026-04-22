// ─── MIDDLE Story Generator ───────────────────────────────────────────────────
// Runs daily on Railway. Calls grok-3, saves stories to Firestore.
// No timeout worries — server can wait as long as Grok needs.
// ─────────────────────────────────────────────────────────────────────────────

const GROK_API_KEY = process.env.GROK_API_KEY;
const FB_PROJECT   = process.env.FB_PROJECT || "themiddle-85852";
const FB_API_KEY   = process.env.FB_API_KEY  || "AIzaSyBxAzJ0bVpOb2hux5OIylBngUDr0ZoH-w4";
const FB_BASE      = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

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
  if (typeof v === "object")  return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}

// ─── Story prompt ─────────────────────────────────────────────────────────────
function buildPrompt(batch) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });

  const batchInstructions = batch === 1
    ? "Focus on the TOP 5 most-discussed political stories right now — the ones with the most coverage across both left and right media."
    : "Focus on the NEXT 5 most-discussed political stories right now — important stories slightly below the very top but still generating significant discussion. Do NOT repeat any stories from the first batch.";

  return `You are the lead editorial writer for "The Middle" — a nonpartisan news app that takes pride in going deeper than any other outlet. Today is ${today}.

Search the web broadly for the 5 most-discussed political stories RIGHT NOW. ${batchInstructions}

EDITORIAL STANDARDS:

1. NEUTRALSUMMARY: 3-4 sentences. Factual. Name specific people, numbers, dates.

2. NEUTRALDETAIL: 6-8 sentences of deep background. Name names. Use specific data. Include history, legislation, what happened most recently, what happens next.

3. LEFTSUMMARY / RIGHTSUMMARY: 3-4 sentences each. The STRONGEST version of each side's argument.

4. CONCLUSION: The Middle's editorial voice. 3-4 paragraphs. Where each side is right, where wrong, what both ignore, what a rational solution looks like. Be willing to say things neither side wants to hear.

5. FACTCHECKS: 10 total, 5 per side alternating right/left. Each claim must be something ACTUALLY being said in the current debate. Explanations: 2-3 sentences with specific evidence. Verdicts: TRUE, FALSE, MISLEADING, or UNVERIFIED.

6. SOCIAL POSTS: Real viral-sounding posts. Reddit analytical, X punchy, Bluesky detailed. Include 2-3 reply thread items.

Return ONLY a raw JSON array. No markdown, no code fences, no preamble. Start with [ end with ].

JSON shape for each story:
{
  "id": "unique-kebab-slug",
  "topic": "Specific descriptive headline with names and stakes",
  "time": "Xh ago",
  "category": "POLITICS",
  "categoryColor": "#818cf8",
  "breaking": false,
  "neutralSummary": "3-4 sentences.",
  "neutralDetail": "6-8 sentences of deep background.",
  "leftSummary": "3-4 sentences — strongest progressive argument.",
  "rightSummary": "3-4 sentences — strongest conservative argument.",
  "commonGround": ["Shared value 1","Shared value 2","Shared value 3","Shared value 4","Shared value 5"],
  "conclusion": "3-4 paragraph editorial.",
  "factChecks": [
    {"claim":"Specific right claim","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences.","likes":18400},
    {"claim":"Specific left claim","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences.","likes":14200},
    {"claim":"Specific right claim","side":"right","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences.","likes":22800},
    {"claim":"Specific left claim","side":"left","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences.","likes":16400},
    {"claim":"Specific right claim","side":"right","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences.","likes":11200},
    {"claim":"Specific left claim","side":"left","verdict":"FALSE","color":"#ef4444","explanation":"2-3 sentences.","likes":19800},
    {"claim":"Specific right claim","side":"right","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences.","likes":13400},
    {"claim":"Specific left claim","side":"left","verdict":"UNVERIFIED","color":"#a78bfa","explanation":"2-3 sentences.","likes":9800},
    {"claim":"Specific right claim","side":"right","verdict":"TRUE","color":"#10b981","explanation":"2-3 sentences.","likes":21200},
    {"claim":"Specific left claim","side":"left","verdict":"MISLEADING","color":"#f59e0b","explanation":"2-3 sentences.","likes":12800}
  ],
  "leftPosts": [
    {"id":"l1","handle":"r/politics","source":"Reddit","avatar":"P","searchQuery":"specific search terms","text":"Viral Reddit post, analytical tone.","likes":34200,"reposts":14800,"url":"https://www.reddit.com/r/politics/search/?q=SEARCHTERMS&sort=top&t=week","thread":[{"avatar":"A","handle":"u/username1","text":"Substantive reply.","likes":8400},{"avatar":"B","handle":"u/username2","text":"Another reply.","likes":3200}]},
    {"id":"l2","handle":"@handle.bsky.social","source":"Bluesky","avatar":"B","searchQuery":"specific search terms","text":"Bluesky post.","likes":18400,"reposts":7200,"url":"https://bsky.app/search?q=SEARCHTERMS","thread":[{"avatar":"C","handle":"@replyhandle","text":"Reply.","likes":2800}]},
    {"id":"l3","handle":"@xhandle","source":"X","avatar":"X","searchQuery":"specific search terms","text":"Punchy X post.","likes":42800,"reposts":19600,"url":"https://x.com/search?q=SEARCHTERMS&src=typed_query&f=live","thread":[{"avatar":"D","handle":"@replyhandle","text":"Reply.","likes":9200}]},
    {"id":"l4","handle":"r/news","source":"Reddit","avatar":"N","searchQuery":"specific search terms","text":"News Reddit post.","likes":28400,"reposts":11200,"url":"https://www.reddit.com/r/news/search/?q=SEARCHTERMS&sort=top&t=week","thread":[{"avatar":"E","handle":"u/newsuser","text":"Reply.","likes":5600}]},
    {"id":"l5","handle":"@handle.bsky.social","source":"Bluesky","avatar":"A","searchQuery":"specific search terms","text":"Second Bluesky post.","likes":14800,"reposts":5800,"url":"https://bsky.app/search?q=SEARCHTERMS","thread":[{"avatar":"F","handle":"@replyhandle","text":"Reply.","likes":2100}]}
  ],
  "rightPosts": [
    {"id":"r1","handle":"r/conservative","source":"Reddit","avatar":"C","searchQuery":"specific search terms","text":"Conservative Reddit post.","likes":44800,"reposts":19800,"url":"https://www.reddit.com/r/conservative/search/?q=SEARCHTERMS&sort=top&t=week","thread":[{"avatar":"G","handle":"u/username","text":"Reply.","likes":12400},{"avatar":"H","handle":"u/username2","text":"Reply.","likes":6800}]},
    {"id":"r2","handle":"@xhandle","source":"X","avatar":"R","searchQuery":"specific search terms","text":"Right-leaning X post.","likes":52200,"reposts":24400,"url":"https://x.com/search?q=SEARCHTERMS&src=typed_query&f=live","thread":[{"avatar":"I","handle":"@replyhandle","text":"Reply.","likes":11200}]},
    {"id":"r3","handle":"r/Republican","source":"Reddit","avatar":"R","searchQuery":"specific search terms","text":"Republican Reddit post.","likes":32800,"reposts":14400,"url":"https://www.reddit.com/r/Republican/search/?q=SEARCHTERMS&sort=top&t=week","thread":[{"avatar":"J","handle":"u/username","text":"Reply.","likes":7200}]},
    {"id":"r4","handle":"@xhandle","source":"X","avatar":"T","searchQuery":"specific search terms","text":"Second right X post.","likes":38800,"reposts":16800,"url":"https://x.com/search?q=SEARCHTERMS&src=typed_query&f=live","thread":[{"avatar":"K","handle":"@replyhandle","text":"Reply.","likes":8800}]},
    {"id":"r5","handle":"@handle.bsky.social","source":"Bluesky","avatar":"S","searchQuery":"specific search terms","text":"Right Bluesky post.","likes":16800,"reposts":6800,"url":"https://bsky.app/search?q=SEARCHTERMS","thread":[{"avatar":"L","handle":"@replyhandle","text":"Reply.","likes":3200}]}
  ]
}

Category colors: POLITICS=#818cf8, WORLD=#ef4444, ECONOMY=#10b981, JUSTICE=#f59e0b, HEALTH=#06b6d4, CULTURE=#ec4899
Verdict colors: TRUE=#10b981, FALSE=#ef4444, MISLEADING=#f59e0b, UNVERIFIED=#a78bfa

Generate exactly 5 stories. Make every word count.`;
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
        {
          role: "system",
          content: "You are the lead editorial AI for MIDDLE. You have live web access. Respond with a raw JSON array only. No markdown, no code fences. Start with [ end with ].",
        },
        { role: "user", content: buildPrompt(batchNum) },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Grok API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Batch ${batchNum} received in ${elapsed}s (${text.length} chars)`);

  const startIdx = text.indexOf("[");
  const endIdx   = text.lastIndexOf("]") + 1;
  if (startIdx === -1 || endIdx === 0) throw new Error("No JSON array in response");

  // Sanitize
  let raw = text.slice(startIdx, endIdx)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\t/g, " ");

  const stories = JSON.parse(raw);
  console.log(`Batch ${batchNum}: ${stories.length} stories parsed OK`);
  return stories;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== MIDDLE Story Generator ===");
  console.log(`Started at: ${new Date().toISOString()}`);

  if (!GROK_API_KEY) {
    throw new Error("GROK_API_KEY environment variable is not set");
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`Generating stories for: ${today}`);

  // Fetch batch 1
  const batch1 = await fetchBatch(1);

  // Save batch 1 immediately so app can start showing stories
  console.log("\nSaving batch 1 to Firestore...");
  await fsSet(`storyCache/${today}`, {
    storiesJson: JSON.stringify(batch1),
    generatedAt: new Date().toISOString(),
    complete: false,
  });
  console.log("Batch 1 saved.");

  // Fetch batch 2
  const batch2 = await fetchBatch(2);

  // Save combined
  const allStories = [...batch1, ...batch2];
  console.log(`\nSaving all ${allStories.length} stories to Firestore...`);
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
