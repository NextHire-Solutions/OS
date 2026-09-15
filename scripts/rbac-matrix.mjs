/*
 * The full access matrix: every tool, granted and not granted.
 *
 *   node scripts/rbac-matrix.mjs [baseUrl]
 *
 * Checks BOTH failure directions, because they are equally bad and only one of
 * them is obvious:
 *
 *   too loose   an ungranted surface is reachable — the hole found on
 *               2026-09-14, where hiding the sidebar was mistaken for enforcing
 *   too strict  a granted user is refused their own tool — which looks like the
 *               product being broken, and would be reported as such
 *
 * A full-access user is checked too: if the gate is wrong, everyone is locked
 * out of everything, and that is the version that takes the workspace down.
 */
import fs from "node:fs";

const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3210";
const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => {
  const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
};
const SECRET = pick("BS_SSO_SECRET") || pick("AUTH_SECRET");

const SURFACES = {
  inbox:      ["/inbox/all-email", "/inbox/archive", "/inbox/settings", "/api/tools/master-inbox/threads?limit=1"],
  clients:    ["/clients", "/clients/biweekly", "/api/tools/client-health/clients"],
  analytics:  ["/analytics/campaign", "/analytics/campaigns", "/analytics/clients", "/api/tools/analytics/clients"],
  onboarding: ["/onboarding/pipeline", "/onboarding/stages", "/api/tools/onboarding/stages"],
  search:     ["/search/search", "/search/mls", "/api/tools/agent-search/status"],
};
// Workspace surfaces belong to no tool and must stay reachable for everyone.
const WORKSPACE = ["/", "/performance", "/roster", "/api/workspace/roster"];

const hit = async (path, cookie) => {
  try {
    const res = await fetch(BASE + path, {
      headers: { cookie: `bs_sso=${cookie}` }, redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    return res.status;
  } catch { return 0; }
};

let tooLoose = 0, tooStrict = 0, ok = 0;

/*
 * 405 counts as REACHED, not as refused.
 *
 * A 405 comes from the route handler saying "not this method", which means the
 * request got past the proxy — so authorisation succeeded. The proxy refuses
 * with 403 for an API path and a redirect for a screen, never with 405.
 * Counting 405 as a denial made two perfectly correct routes look like
 * lockouts, which is the kind of false red that gets a real one ignored.
 */
const reachable = (s) => s === 200 || s === 405;
const refused = (s) => s === 403 || (s >= 300 && s < 400);

for (const granted of ALL_TOOLS) {
  const token = await mintSso(SECRET, { email: `only-${granted}@brokerstaffer.com`, grants: [granted], ver: 1 });
  const bad = [];
  for (const [tool, paths] of Object.entries(SURFACES)) {
    for (const p of paths) {
      const s = await hit(p, token);
      if (tool === granted) {
        if (reachable(s)) ok++; else { tooStrict++; bad.push(`LOCKED OUT of own tool: ${p} → ${s}`); }
      } else {
        if (refused(s)) ok++; else { tooLoose++; bad.push(`LEAK: ${p} → ${s}`); }
      }
    }
  }
  for (const p of WORKSPACE) {
    const s = await hit(p, token);
    if (reachable(s)) ok++; else { tooStrict++; bad.push(`workspace surface refused: ${p} → ${s}`); }
  }
  console.log(`  ${bad.length === 0 ? "✓" : "✗"} grants=[${granted}]`.padEnd(34) + `${bad.length === 0 ? "correct" : bad.length + " problem(s)"}`);
  for (const b of bad) console.log(`      ${b}`);
}

// Full access must reach everything.
const full = await mintSso(SECRET, { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
const fullBad = [];
for (const paths of Object.values(SURFACES)) {
  for (const p of paths) { const s = await hit(p, full); if (reachable(s)) ok++; else { tooStrict++; fullBad.push(`${p} → ${s}`); } }
}
for (const p of WORKSPACE) { const s = await hit(p, full); if (reachable(s)) ok++; else { tooStrict++; fullBad.push(`${p} → ${s}`); } }
console.log(`  ${fullBad.length === 0 ? "✓" : "✗"} grants=[all]`.padEnd(34) + `${fullBad.length === 0 ? "reaches everything" : fullBad.length + " refused"}`);
for (const b of fullBad) console.log(`      ${b}`);

console.log(`\n  ${ok} correct · ${tooLoose} leak(s) · ${tooStrict} wrongly refused`);
console.log(tooLoose === 0 && tooStrict === 0
  ? "  ✅ access matches grants exactly, in both directions\n"
  : "  ✗ access control is wrong\n");
/* ------------------------------------------------------------------------
 * PUBLIC-AT-THE-PROXY PATHS MUST FAIL CLOSED IN THE HANDLER.
 *
 * The proxy lets provider webhooks and machine callers through without a
 * session. That is only safe if every such handler refuses on its own — a
 * missing secret must be 503, a wrong one 401/403, and nothing may ever answer
 * 2xx to an anonymous caller. This section proves it on the deployed site;
 * without it, "the handler checks the secret" is a promise, not a fact.
 * ------------------------------------------------------------------------ */
const PUBLIC_PATHS = [
  // Master Inbox — provider webhooks, cron, register (path-only bypass)
  ["POST", "/api/tools/master-inbox/webhooks/instantly"],
  ["POST", "/api/tools/master-inbox/webhooks/emailbison"],
  ["POST", "/api/tools/master-inbox/webhooks/register?token=wrong"],
  ["POST", "/api/tools/master-inbox/cron/sync-external-intros"],
  ["POST", "/api/tools/master-inbox/admin/instantly/register-webhook?token=wrong"],
  // Client Health — token routes (header-gated at the proxy, secret-checked in the handler)
  ["GET",  "/api/tools/client-health/clients", { "x-admin-token": "wrong" }],
  ["GET",  "/api/tools/client-health/clients/status", { "x-admin-token": "wrong" }],
  ["POST", "/api/tools/client-health/clients/onboard", { "x-admin-token": "wrong" }],
  ["GET",  "/api/tools/client-health/metrics/weekly", { "x-admin-token": "wrong" }],
  ["POST", "/api/tools/client-health/sync", { "x-sync-secret": "wrong" }],
  ["POST", "/api/tools/client-health/sync/tick", { "x-sync-secret": "wrong" }],
  // Onboarding — provider receivers and cron (prefix bypass at the proxy)
  ["POST", "/api/tools/onboarding/webhooks/typeform"],
  ["POST", "/api/tools/onboarding/webhooks/calendly?token=wrong"],
  ["POST", "/api/tools/onboarding/webhooks/stripe?token=wrong"],
  ["POST", "/api/tools/onboarding/webhooks/bison?token=wrong"],
  ["POST", "/api/tools/onboarding/webhooks/masterinbox?token=wrong"],
  ["GET",  "/api/tools/onboarding/cron/tick", { authorization: "Bearer wrong" }],
  ["GET",  "/api/tools/onboarding/cron/poll-replies", { authorization: "Bearer wrong" }],
  // Analytics — bearer-gated machine trigger
  ["POST", "/api/tools/analytics/sync/run?job=sync-replies", { authorization: "Bearer wrong" }],
];
const closed = (s) => s === 401 || s === 403 || s === 503 || s === 405 || s === 400;
let publicBad = 0;
console.log("\n  PUBLIC PATHS — anonymous / wrong-secret callers must be refused:");
for (const [method, path, headers = {}] of PUBLIC_PATHS) {
  let status = -1, body = "";
  try {
    const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...headers }, body: method === "POST" ? "{}" : undefined, redirect: "manual" });
    status = res.status; body = (await res.text()).slice(0, 80);
  } catch (e) { body = String(e); }
  const ok = closed(status);
  if (!ok) publicBad++;
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${method.padEnd(4)} ${path.padEnd(70)} ${status}${ok ? "" : "  ← " + body}`);
}
console.log(publicBad ? `\n  ✗ ${publicBad} public path(s) answered an anonymous caller` : "\n  ✓ every public path fails closed");

process.exit(tooLoose || tooStrict || publicBad ? 1 : 0);

