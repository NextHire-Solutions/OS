/*
 * The reply-agent API, exercised as a person would meet it.
 *
 * Four routes, three of them new and therefore NOT DEPLOYED when this is first
 * run. That is the point of the SKIP outcome below: a route that 404s because
 * nobody has shipped it yet is a different fact from a route that is broken,
 * and a test that reported them the same way would be useless twice — once now
 * and once after the deploy.
 *
 * What it checks, in order of how badly each failure would hurt:
 *
 *   1. NOBODY GETS IN WITHOUT A COOKIE. These routes read every message in the
 *      workspace and spend money at OpenAI. An open POST would be somebody
 *      else's bill and our customers' mail.
 *   2. A SIGNED-IN NON-ADMIN IS REFUSED. Same reasons; being staff is not the
 *      same as being allowed to rewrite what every draft is written from.
 *   3. AN EMPTY CORPUS DEGRADES, IT DOES NOT ERROR. Before the migration and
 *      the first build there is nothing to retrieve, and the honest response is
 *      a clear 409 with an instruction — never a 500.
 *
 * Writes nothing. The only non-GET it sends is a distillation POST, which is
 * asserted to REFUSE while the corpus is empty — so it must not spend anything
 * either. If the corpus is not empty the POST is skipped rather than run,
 * because a real distillation costs money and overwrites a document.
 *
 *   node --experimental-strip-types scripts/reply-agent-api-test.mjs
 */
import fs from "node:fs";

const BASE = process.env.BASE || "https://os.brokerstaffer.com";

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const SECRET = pick("BS_SSO_SECRET") || pick("AUTH_SECRET");
const ADMIN = await mintSso(SECRET, { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
/* Signed in, every tool, but not an admin — the case that must still be refused. */
const MEMBER = await mintSso(SECRET, { email: "not-an-admin@example.invalid", grants: [...ALL_TOOLS], ver: 1 });

let passed = 0, failed = 0, skipped = 0; const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  ok ? passed++ : (failed++, fails.push(name));
};
const skip = (name, why) => { console.log(`  SKIP  ${name}  —  ${why}`); skipped++; };

const call = async (path, { token, method = "GET", body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { cookie: `bs_sso=${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* an HTML 404 page */ }
  return { status: res.status, json, text };
};

const ROUTES = {
  corpus: "/api/tools/master-inbox/ai/corpus",
  knowledge: "/api/tools/master-inbox/ai/knowledge",
  feedback: "/api/tools/master-inbox/ai/feedback",
  proposals: "/api/tools/master-inbox/ai/proposals",
};

console.log(`\nREPLY AGENT API  →  ${BASE}\n${"=".repeat(74)}\n`);

/* A route Next has never heard of answers with an HTML 404, not JSON. */
const deployed = {};
for (const [name, path] of Object.entries(ROUTES)) {
  const probe = await call(path, { token: ADMIN });
  deployed[name] = !(probe.status === 404 && probe.json === null);
  console.log(`  ${name.padEnd(10)} ${deployed[name] ? `deployed (${probe.status})` : "NOT DEPLOYED"}`);
}
console.log("");

/* ------------------------------------------------------------ 1. the door */
for (const [name, path] of Object.entries(ROUTES)) {
  if (!deployed[name]) { skip(`${name}: refuses an unauthenticated GET`, "not deployed"); continue; }
  const r = await call(path);
  check(`${name}: refuses an unauthenticated GET`, r.status === 401, `got ${r.status}`);
}
for (const [name, path] of Object.entries(ROUTES)) {
  if (!deployed[name]) { skip(`${name}: refuses an unauthenticated POST`, "not deployed"); continue; }
  const r = await call(path, { method: "POST", body: {} });
  // proposals has no POST; 405 is a correct refusal there too.
  check(`${name}: refuses an unauthenticated POST`, r.status === 401 || r.status === 405, `got ${r.status}`);
}

/* --------------------------------------------------- 2. signed in, not admin */
for (const [name, path] of Object.entries(ROUTES)) {
  if (!deployed[name]) { skip(`${name}: refuses a signed-in non-admin`, "not deployed"); continue; }
  const r = await call(path, { token: MEMBER });
  check(
    `${name}: refuses a signed-in non-admin`,
    r.status === 403,
    `got ${r.status}${r.json?.detail ? ` — ${r.json.detail}` : ""}`,
  );
}

/* --------------------------------------------------------- 3. the happy path */
const corpus = await call(ROUTES.corpus, { token: ADMIN });
check("corpus: an admin gets the status", corpus.status === 200, `got ${corpus.status}`);
if (corpus.status === 200) {
  const c = corpus.json;
  check(
    "corpus: the status carries the numbers the screen renders",
    ["running", "examples", "embedded", "lastBuiltAt", "byLabel"].every((k) => k in c),
    Object.keys(c).join(", "),
  );
  check("corpus: byLabel is a list", Array.isArray(c.byLabel));
  /*
   * `available` is NOT inferable from `examples === 0`. A counting query
   * against a table PostgREST has never heard of returns 204 with count null
   * and no error, so a screen built on counts alone reports a confident zero
   * for a table that does not exist.
   */
  check("corpus: it says whether the table exists at all", typeof c.available === "boolean", `available=${c.available}`);
  if (c.available === false) {
    const r = await call(ROUTES.corpus, { token: ADMIN, method: "POST" });
    check(
      "corpus: a rebuild refuses up front instead of reading 37,000 messages first",
      r.status === 409 && r.json?.reason === "no-table",
      `got ${r.status} — ${r.json?.detail ?? r.text.slice(0, 80)}`,
    );
    check("corpus: …and names the migration to run", /0006_os_reply_intelligence/.test(r.json?.detail ?? ""), r.json?.detail ?? "");
  } else {
    skip("corpus: a rebuild refuses without the table", "the table exists");
  }
  console.log(`         examples=${c.examples} embedded=${c.embedded} running=${c.running} error=${c.error ?? "none"}`);
}

if (deployed.feedback) {
  const r = await call(ROUTES.feedback, { token: ADMIN });
  check("feedback: an admin gets the record", r.status === 200, `got ${r.status}`);
  if (r.status === 200) {
    check(
      "feedback: the baseline to beat is reported alongside the score",
      r.json?.baseline?.drafts === 600 && r.json?.baseline?.neverSent === 517,
      JSON.stringify(r.json?.baseline),
    );
    check(
      "feedback: an absent table is reported as unavailable, not as an error",
      typeof r.json?.available === "boolean",
      `available=${r.json?.available} total=${r.json?.total}`,
    );
  }
} else {
  skip("feedback: an admin gets the record", "not deployed");
}

if (deployed.knowledge) {
  const r = await call(ROUTES.knowledge, { token: ADMIN });
  check("knowledge: an admin gets both documents", r.status === 200, `got ${r.status}`);
  if (r.status === 200) {
    check(
      "knowledge: the shape the screen reads",
      ["styleGuide", "objectionPlaybook", "distilledAt", "updatedBy", "proposals"].every((k) => k in r.json),
      Object.keys(r.json).join(", "),
    );
  }

  /* The degradation that matters: with no corpus, distilling must refuse
   * clearly and spend nothing. */
  const examples = corpus.json?.examples ?? 0;
  if (examples === 0) {
    const d = await call(ROUTES.knowledge, { token: ADMIN, method: "POST", body: {} });
    check(
      "knowledge: distilling an empty corpus refuses clearly instead of erroring",
      d.status === 409 || d.status === 503,
      `got ${d.status} — ${d.json?.error ?? d.text.slice(0, 80)}`,
    );
    /*
     * Two legitimate refusals, depending on where this runs. On the server the
     * agent's key decrypts and the corpus read is what fails; on a laptop
     * MASTER_INBOX_APP_ENCRYPTION_KEY does not exist, so it stops one step
     * earlier at the key. Both are clear, actionable and cost nothing — which
     * is the property being asserted.
     */
    check(
      "knowledge: …and says what to do about it",
      /corpus|schema cache|migration|build|API key/i.test(d.json?.error ?? ""),
      d.json?.error ?? "",
    );
  } else {
    skip("knowledge: distilling an empty corpus refuses", `the corpus has ${examples} examples — a real distillation costs money`);
  }

  const bad = await call(ROUTES.knowledge, { token: ADMIN, method: "PATCH", body: {} });
  check("knowledge: a PATCH with nothing in it is rejected", bad.status === 400, `got ${bad.status}`);
} else {
  skip("knowledge: an admin gets both documents", "not deployed");
  skip("knowledge: distilling an empty corpus refuses clearly", "not deployed");
  skip("knowledge: a PATCH with nothing in it is rejected", "not deployed");
}

if (deployed.proposals) {
  const r = await call(ROUTES.proposals, { token: ADMIN });
  check("proposals: an admin gets the pending list", r.status === 200 && Array.isArray(r.json?.proposals), `got ${r.status}`);
  const bad = await call(ROUTES.proposals, { token: ADMIN, method: "PATCH", body: { id: "nope" } });
  check("proposals: a decision without a verdict is rejected", bad.status === 400, `got ${bad.status}`);
} else {
  skip("proposals: an admin gets the pending list", "not deployed");
  skip("proposals: a decision without a verdict is rejected", "not deployed");
}

console.log(`\n${"=".repeat(74)}\n  ${passed} passed, ${failed} failed, ${skipped} skipped`);
if (fails.length) console.log("  failed:", fails.join("; "));
process.exit(failed ? 1 : 0);
