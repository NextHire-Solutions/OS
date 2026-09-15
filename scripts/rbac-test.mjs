/*
 * Role-based access: can a user reach a tool they were not granted?
 *
 *   node scripts/rbac-test.mjs [baseUrl]
 *
 * The question that matters is NOT whether the sidebar hides a tool. Hiding is
 * cosmetic — anyone can type a URL. The question is whether the SERVER refuses:
 *
 *   · the tool's screens
 *   · the tool's API routes, which carry the actual data
 *
 * A workspace that hides Analytics but serves /api/tools/analytics/* to
 * everyone has not restricted anything; it has only made the breach quieter.
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

/* Screens and one data-bearing API per tool. */
const SURFACES = {
  inbox:      { screens: ["/inbox/all-email", "/inbox/settings"], api: ["/api/tools/master-inbox/threads?limit=1"] },
  clients:    { screens: ["/clients"],                            api: ["/api/tools/client-health/clients"] },
  analytics:  { screens: ["/analytics/campaign", "/analytics/campaigns"], api: ["/api/tools/analytics/clients"] },
  onboarding: { screens: ["/onboarding/pipeline"],                api: ["/api/tools/onboarding/stages"] },
  search:     { screens: ["/search/search"],                      api: ["/api/tools/agent-search/status"] },
};

async function hit(path, cookie) {
  try {
    const res = await fetch(BASE + path, {
      headers: { cookie: `bs_sso=${cookie}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    return res.status;
  } catch { return 0; }
}

// Granted ONE tool only.
const GRANTED = "analytics";
const token = await mintSso(SECRET, { email: "limited@brokerstaffer.com", grants: [GRANTED], ver: 1 });
console.log(`  token grants: ["${GRANTED}"] only\n`);

let leaks = 0, ok = 0;

for (const [tool, { screens, api }] of Object.entries(SURFACES)) {
  const shouldAllow = tool === GRANTED;
  for (const path of [...screens, ...api]) {
    const status = await hit(path, token);
    const reachable = status === 200;
    const denied = status === 403 || status === 401 || (status >= 300 && status < 400);
    const kind = path.startsWith("/api") ? "API   " : "screen";

    if (shouldAllow) {
      const good = reachable;
      console.log(`  ${good ? "✓" : "✗"} ${kind} ${path.padEnd(46)} ${status}  (granted — should be reachable)`);
      good ? ok++ : leaks++;
    } else {
      const good = denied;
      console.log(`  ${good ? "✓" : "✗ LEAK"} ${kind} ${path.padEnd(46)} ${status}  (NOT granted — should be refused)`);
      good ? ok++ : leaks++;
    }
  }
}

// And the sidebar: does the shell even offer the other tools?
const res = await fetch(BASE + "/analytics/campaign", { headers: { cookie: `bs_sso=${token}` } });
const html = await res.text();
console.log("\n  sidebar contents with a single grant:");
for (const t of ALL_TOOLS) {
  const shown = new RegExp(`data-tool="${t}"|/${t === "inbox" ? "inbox" : t}/`, "i").test(html);
  console.log(`    ${t.padEnd(12)} ${shown ? "visible in markup" : "absent"}`);
}

console.log(`\n  ${ok} correct · ${leaks} problem(s)`);
console.log(leaks === 0
  ? "  ✅ the server refuses every ungranted surface\n"
  : `  ✗ ${leaks} ungranted surface(s) reachable — hiding is not enforcing\n`);
process.exit(leaks ? 1 : 0);
