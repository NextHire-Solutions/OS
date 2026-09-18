/*
 * The corpus build, read-only, from a laptop.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE JOB
 *
 * `buildReplyCorpus` can only run on the server: embedding needs the reply
 * agent's OpenAI key, which is encrypted with a key that lives on Railway, and
 * writing needs `os_reply_examples`. Neither is available here.
 *
 * But every JUDGEMENT the build makes — what pairs, what is rejected and why,
 * what each example is worth, what survives de-duping — lives in corpus-pure.ts
 * and needs nothing but the messages. So this script pages the same rows in the
 * same order and runs the same functions, which is how we get the rejection
 * breakdown and the per-situation counts without writing a single row.
 *
 * It is READ-ONLY by construction: the only verbs it uses are GETs.
 *
 *   node --experimental-strip-types scripts/corpus-dry-run.mjs
 */
import fs from "node:fs";

const {
  pairTurns, rejectExample, qualityScore, dedupe,
} = await import("../src/lib/tools/master-inbox/ai/corpus-pure.ts");

const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const SB = pick("MASTER_INBOX_SUPABASE_URL");
const SK = pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY");
const WS = pick("MASTER_INBOX_WORKSPACE_ID");

const get = async (path) => {
  const res = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: SK, Authorization: `Bearer ${SK}` } });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};
/* PostgREST caps a page at 1000 server-side; the only way past it is to page. */
const all = async (path) => {
  const out = [];
  for (let off = 0; off < 200_000; off += 1000) {
    const page = await get(`${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${off}`);
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
};

console.log(`\nCORPUS DRY RUN (read-only)\n${"=".repeat(74)}\n`);

const labels = await all(`labels?select=id,name&workspace_id=eq.${WS}`);
const labelName = new Map(labels.map((l) => [l.id, l.name]));
const assignments = await all(`label_assignments?select=label_id,target_id&workspace_id=eq.${WS}&target_type=eq.thread`);
const threadLabels = new Map();
for (const a of assignments) {
  const n = labelName.get(a.label_id);
  if (!n) continue;
  const list = threadLabels.get(a.target_id) ?? [];
  list.push(n);
  threadLabels.set(a.target_id, list);
}
console.log(`labels ${labels.length}, labelled threads ${threadLabels.size}`);

const rejected = {};
let threadsSeen = 0, pairsFound = 0;
const staged = [];

let buffer = [], bufferThread = null;
const flush = () => {
  if (!bufferThread || buffer.length === 0) return;
  threadsSeen++;
  const tl = threadLabels.get(bufferThread) ?? [];
  const label = tl[0] ?? null;
  for (const pair of pairTurns(buffer)) {
    pairsFound++;
    const why = rejectExample({ ...pair, label });
    if (why) { rejected[why] = (rejected[why] ?? 0) + 1; continue; }
    staged.push({
      label,
      replyText: pair.replyText,
      quality: qualityScore({ sentAt: pair.sentAt, label, threadLabels: tl, source: "history", replyText: pair.replyText }),
    });
  }
  buffer = [];
};

let read = 0;
for (let off = 0; off < 200_000; off += 1000) {
  const rows = await get(
    `messages?select=id,thread_id,direction,body_text,body_html,sent_at&workspace_id=eq.${WS}` +
    `&order=thread_id.asc,sent_at.asc&limit=1000&offset=${off}`,
  );
  if (rows.length === 0) break;
  for (const r of rows) {
    if (r.thread_id !== bufferThread) { flush(); bufferThread = r.thread_id; }
    buffer.push({ id: r.id, direction: r.direction, bodyText: r.body_text, bodyHtml: r.body_html, sentAt: r.sent_at });
  }
  read += rows.length;
  if (read % 10000 === 0) console.log(`  ${read} messages read, ${staged.length} kept`);
  if (rows.length < 1000) break;
}
flush();

const deduped = dedupe(staged, 3);

console.log(`\nmessages read      ${read}`);
console.log(`threads seen       ${threadsSeen}`);
console.log(`reply pairs found  ${pairsFound}`);
console.log(`kept after filter  ${staged.length}`);
console.log(`after de-duping    ${deduped.length}   <- what a real build would write`);

console.log(`\nREJECTIONS`);
for (const [k, v] of Object.entries(rejected).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(6)}  ${k}`);
}
console.log(`  ${String(Object.values(rejected).reduce((a, b) => a + b, 0)).padStart(6)}  TOTAL rejected`);

const tally = new Map();
for (const r of deduped) {
  const k = r.label ?? "unlabelled";
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
console.log(`\nBY SITUATION (of the ${deduped.length} that would be written)`);
for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(6)}  ${k}`);
}

const q = deduped.map((r) => r.quality).sort((a, b) => a - b);
const at = (p) => q[Math.floor(q.length * p)] ?? 0;
console.log(`\nquality  min ${q[0]}  p25 ${at(0.25)}  median ${at(0.5)}  p75 ${at(0.75)}  max ${q[q.length - 1]}`);
