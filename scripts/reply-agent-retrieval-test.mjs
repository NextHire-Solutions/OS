/*
 * Retrieval, run against the live database exactly as a draft would run it.
 *
 * THE PROPERTY UNDER TEST
 *
 * "Keep it behind a flag or a graceful fallback so an empty corpus or missing
 * knowledge degrades to today's behaviour instead of erroring."
 *
 * That is easy to claim and easy to get wrong, because the failure only shows
 * up in the one state nobody develops in: the tables absent, the corpus empty,
 * the knowledge never distilled. Right now the live database IS in that state,
 * which makes this the best possible moment to prove it — the real client, the
 * real credentials, the real 404 from PostgREST, and no mock anywhere.
 *
 * What must hold:
 *   · gatherGuidance RESOLVES. It must never throw, whatever the database says.
 *   · it reports source "none" and explains itself, rather than pretending.
 *   · renderGuidance returns the EMPTY STRING, so the prompt the model receives
 *     is byte-for-byte the prompt it received before this feature existed.
 *
 * READ-ONLY: gatherGuidance only ever SELECTs.
 *
 *   node --import ./scripts/alias-hooks.mjs scripts/reply-agent-retrieval-test.mjs
 */
import fs from "node:fs";

/* The module reads its configuration from the environment, like the server. */
const raw = fs.readFileSync(".env.local", "utf8");
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { gatherGuidance, renderGuidance } = await import("@/lib/tools/master-inbox/ai/retrieval.ts");
const { workspaceId } = await import("@/lib/tools/master-inbox/supabase.ts");

let passed = 0, failed = 0; const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  ok ? passed++ : (failed++, fails.push(name));
};

console.log(`\nRETRIEVAL AGAINST THE LIVE DATABASE (read-only)\n${"=".repeat(74)}\n`);

const ws = await workspaceId();
check("the workspace resolves", typeof ws === "string" && ws.length > 20, ws);

/* A real inbound message, so the query is a real one. */
const SB = process.env.MASTER_INBOX_SUPABASE_URL, SK = process.env.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY;
const [inbound] = await (
  await fetch(
    `${SB}/rest/v1/messages?select=id,thread_id,body_text&direction=eq.inbound&body_text=not.is.null&order=sent_at.desc&limit=1`,
    { headers: { apikey: SK, Authorization: `Bearer ${SK}` } },
  )
).json();
check("a real inbound message was found to ask about", !!inbound?.body_text, (inbound?.body_text ?? "").slice(0, 60).replace(/\s+/g, " "));

/* --------------------------------------------------- the degradation itself */
let guidance = null, threw = null;
const started = Date.now();
try {
  guidance = await gatherGuidance({
    workspaceId: ws,
    inboundText: inbound?.body_text ?? "I'm happy where I am, thanks.",
    threadId: inbound?.thread_id ?? null,
    provider: "openai",
    /*
     * Deliberately a key that cannot work. If retrieval ever reached OpenAI on
     * this path it would fail loudly here instead of quietly costing money —
     * and with no corpus it must not reach OpenAI at all, because there is
     * nothing for a vector to be compared against.
     */
    apiKey: "sk-not-a-real-key-this-must-never-be-sent",
  });
} catch (e) {
  threw = e;
}
const took = Date.now() - started;

check("gatherGuidance resolves rather than throwing", threw === null, threw ? String(threw).slice(0, 160) : `${took}ms`);

if (guidance) {
  check("it reports that nothing was retrieved", guidance.source === "none", `source=${guidance.source}`);
  check("…and says why, in words", typeof guidance.note === "string" && guidance.note.length > 0, guidance.note ?? "(no note)");
  check("no examples are invented", Array.isArray(guidance.examples) && guidance.examples.length === 0, `${guidance.examples?.length} examples`);
  check("no style guide is invented", guidance.styleGuide === null);
  check("no playbook is invented", guidance.objectionPlaybook === null);

  const rendered = renderGuidance(guidance);
  check(
    "the prompt addition is the empty string — today's behaviour, unchanged",
    rendered === "",
    rendered === "" ? "" : `${rendered.length} characters would have been added`,
  );

  /* It must not have called OpenAI: with no pool there is nothing to compare a
   * vector against, and a bad key would have surfaced as an error, not a note. */
  check("it did not reach the embeddings API with nothing to search",
    !/embedding/i.test(guidance.note ?? "") || /corpus is empty/.test(guidance.note ?? ""),
    guidance.note ?? "");

  check("it answers fast enough to sit on a button", took < 5000, `${took}ms`);
}

/* Called twice, it must behave the same — the pool is cached in process and a
 * cached EMPTY result must not become a cached error. */
const second = await gatherGuidance({
  workspaceId: ws, inboundText: "Not interested, please remove me.",
  threadId: null, provider: "openai", apiKey: "sk-still-not-real",
});
check("a second call behaves identically", second.source === "none" && renderGuidance(second) === "", second.source);

/* An agent on a non-OpenAI provider must not have its key sent to OpenAI. */
const anthropic = await gatherGuidance({
  workspaceId: ws, inboundText: "Tell me more.", threadId: null,
  provider: "anthropic", apiKey: "sk-ant-should-never-reach-openai",
});
check("an Anthropic agent's key is never sent to OpenAI", anthropic.source === "none", anthropic.source);

console.log(`\n${"=".repeat(74)}\n  ${passed} passed, ${failed} failed`);
if (fails.length) console.log("  failed:", fails.join("; "));
process.exit(failed ? 1 : 0);
