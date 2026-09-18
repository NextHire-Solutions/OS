/*
 * The verdict, measured against real drafts and the real replies that followed.
 *
 * WHY THIS TEST AND NOT A UNIT TEST
 *
 * `verdictFor` is already unit-tested on strings somebody typed. What that
 * cannot tell us is whether the PAIRING is right — whether the outbound message
 * this code calls "what the draft became" really is that, on data nobody wrote
 * to be convenient. Two things in this mailbox make it easy to get wrong:
 *
 *   · replies are stored HTML-encoded, so "you&#039;re" and "you're" are the
 *     same sentence and must not read as a human edit
 *   · `reply_drafts.sent_message_id` is null on all 12,451 rows, so pairing has
 *     to be done by time, and a draft abandoned in March must not pair with an
 *     unrelated reply sent in July
 *
 * Both of those would silently produce a WRONG metric rather than an error,
 * which is the failure mode this whole screen exists to avoid.
 *
 * READ-ONLY. Every request is a GET; nothing is written, and the os_ tables are
 * not touched at all.
 *
 *   node --experimental-strip-types scripts/reply-agent-verdicts-test.mjs
 */
import fs from "node:fs";

const { normaliseBody, comparable, verdictFor } = await import(
  "../src/lib/tools/master-inbox/ai/corpus-pure.ts"
);

const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const SB = pick("MASTER_INBOX_SUPABASE_URL"), SK = pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY"), WS = pick("MASTER_INBOX_WORKSPACE_ID");

const get = async (p) => {
  const r = await fetch(`${SB}/rest/v1/${p}`, { headers: { apikey: SK, Authorization: `Bearer ${SK}` } });
  if (!r.ok) throw new Error(`${p} → ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
};

let passed = 0, failed = 0; const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  ok ? passed++ : (failed++, fails.push(name));
};

console.log(`\nREPLY AGENT — VERDICTS AGAINST REAL DRAFTS (read-only)\n${"=".repeat(74)}\n`);

/* The same window the backfill uses. A draft and a reply further apart than
 * this are not the same act. */
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------- the drafts and the replies */
const drafts = await get(
  `reply_drafts?select=id,thread_id,status,created_at,generated_body&workspace_id=eq.${WS}` +
  `&generated_body=not.is.null&order=created_at.desc&limit=600`,
);
check("there are drafts on file to judge", drafts.length > 100, `${drafts.length} read`);

const threadIds = [...new Set(drafts.map((d) => d.thread_id).filter(Boolean))];
const messages = [];
for (let i = 0; i < threadIds.length; i += 40) {
  const slice = threadIds.slice(i, i + 40);
  messages.push(
    ...(await get(
      `messages?select=id,thread_id,body_text,body_html,sent_at&direction=eq.outbound` +
      `&thread_id=in.(${slice.join(",")})&order=sent_at.asc&limit=1000`,
    )),
  );
}
const outboundByThread = new Map();
for (const m of messages) {
  const list = outboundByThread.get(m.thread_id) ?? [];
  list.push(m);
  outboundByThread.set(m.thread_id, list);
}
console.log(`  (${threadIds.length} threads, ${messages.length} outbound messages)\n`);

/* --------------------------------------------------------------- the pairing */
const judge = (d) => {
  const createdAt = new Date(d.created_at).getTime();
  const outs = (outboundByThread.get(d.thread_id) ?? []).filter((m) => m.sent_at);
  const match = outs.find((m) => {
    const t = new Date(m.sent_at).getTime();
    return t >= createdAt && t - createdAt <= WINDOW_MS;
  });
  const drafted = normaliseBody(d.generated_body, null);
  if (!match) return { verdict: "discarded", similarity: null, match: null, drafted };
  const sent = normaliseBody(match.body_text, match.body_html);
  return { ...verdictFor(drafted, sent), match, drafted, sent };
};

const results = drafts.map((d) => ({ draft: d, ...judge(d) }));
const tally = {};
for (const r of results) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;

console.log("  verdicts:", JSON.stringify(tally), "\n");

check(
  "every verdict is one the table's CHECK constraint allows",
  results.every((r) => ["as_written", "light_edit", "rewritten", "discarded"].includes(r.verdict)),
  Object.keys(tally).join(", "),
);

/* A draft can never have become a reply sent BEFORE it was written. This is the
 * property a naive "latest outbound on the thread" pairing gets wrong. */
const backwards = results.filter(
  (r) => r.match && new Date(r.match.sent_at).getTime() < new Date(r.draft.created_at).getTime(),
);
check("no draft is paired with a reply that predates it", backwards.length === 0, `${backwards.length} backwards`);

const tooFar = results.filter(
  (r) => r.match && new Date(r.match.sent_at).getTime() - new Date(r.draft.created_at).getTime() > WINDOW_MS,
);
check("no draft is paired across the 14-day window", tooFar.length === 0, `${tooFar.length} beyond`);

/* A draft still sitting in 'pending' was, by definition, never acted on — so it
 * must never come back as a send. This catches an off-by-one in the pairing
 * that would flatter the agent's record. */
const pendingButPaired = results.filter((r) => r.draft.status === "pending" && r.verdict !== "discarded");
check(
  "a still-pending draft is never scored as sent",
  pendingButPaired.length === 0,
  pendingButPaired.length ? `${pendingButPaired.length} pending drafts paired with a reply` : "",
);

/* Determinism: the metric must not wobble between runs. */
const again = drafts.map((d) => judge(d).verdict).join("|");
check("judging twice gives the same answer", again === results.map((r) => r.verdict).join("|"));

/* -------------------------------------------- the encoding trap, on real data */
const encoded = messages.find((m) => /&#0?39;|&quot;|&amp;|&nbsp;/.test(m.body_text ?? m.body_html ?? ""));
if (encoded) {
  const stored = encoded.body_text ?? encoded.body_html;
  const decoded = stored
    .replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  check(
    "an entity-encoded reply and its decoded twin compare as identical",
    comparable(stored, null) === comparable(decoded, null),
    stored.slice(0, 48).replace(/\s+/g, " "),
  );
  check(
    "…and therefore score as sent as written, not as an edit",
    verdictFor(decoded, stored).verdict === "as_written",
    verdictFor(decoded, stored).verdict,
  );
} else {
  check("a reply with HTML entities was found to test against", false, "none in this sample");
}

/* A real sent reply against itself must be 'as_written' — the floor of the
 * whole measurement. If this fails, every number on the screen is wrong. */
const withBody = results.find((r) => r.sent && r.sent.length > 80);
if (withBody) {
  check("a real reply compared with itself is 'as written'", verdictFor(withBody.sent, withBody.sent).verdict === "as_written");
  check(
    "a real reply compared with unrelated text is 'rewritten'",
    verdictFor("Thanks, I'll pass that along to the team and revert next week.", withBody.sent).verdict === "rewritten",
  );
} else {
  check("a paired reply with a real body was found", false, "none in this sample");
}

/* ------------------------------------------------- the baseline, sanity-checked
 * The brief's measured figure is that the old agent's drafts were overwhelmingly
 * never sent. If this sample disagreed wildly, the pairing would be suspect. */
const discardRate = (tally.discarded ?? 0) / results.length;
check(
  "most drafts were never sent, as the baseline says",
  discardRate > 0.5,
  `${Math.round(discardRate * 100)}% discarded`,
);
check(
  "almost none went out untouched, as the baseline says",
  (tally.as_written ?? 0) / results.length < 0.15,
  `${tally.as_written ?? 0} of ${results.length} as written`,
);

console.log(`\n${"=".repeat(74)}\n  ${passed} passed, ${failed} failed`);
if (fails.length) console.log("  failed:", fails.join("; "));
process.exit(failed ? 1 : 0);
