/*
 * What the data layer returns when a tool cannot be reached.
 *
 *   node --import ./scripts/alias-hooks.mjs scripts/degraded-logic-test.mjs
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A BROWSER TEST
 *
 * Two earlier attempts blocked URLs in Chrome and found every screen rendering
 * full data. Both were wrong for the same reason, discovered one layer at a
 * time: the workspace does not call the tools' websites (it reads their
 * databases), and it does not read those databases FROM THE BROWSER either —
 * it renders on the server. `Network.setBlockedURLs` only ever blocked
 * requests the page made, and the page makes none of these.
 *
 * So the degradation is tested where it happens: call the loaders directly
 * with the upstream pointed somewhere unreachable.
 *
 * ---------------------------------------------------------------------------
 * WHAT MUST BE TRUE
 *
 *   · it must not THROW — a screen that crashes shows nothing at all
 *   · it must SAY it is unavailable, in words
 *   · it must NOT return 0 where it means "unknown". A zero in a client's
 *     introductions column reads as "nobody was introduced", which is a
 *     confident claim about a real client that nobody can support.
 */
import fs from "node:fs";

const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

let pass = 0, fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// An address that resolves to nothing, so the fetch fails the way a dead tool would.
const DEAD = "https://unreachable.invalid";

/* ---------------------------------------------------------- Performance -- */
{
  const original = process.env.CLIENT_HEALTH_URL;
  process.env.CLIENT_HEALTH_URL = DEAD;
  const { getPerformance } = await import("@/lib/workspace/performance.ts?dead=1");
  let result = null, threw = null;
  try { result = await getPerformance(); } catch (e) { threw = e.message; }
  process.env.CLIENT_HEALTH_URL = original;

  check(!threw, "Performance does not throw when Client Health is unreachable", threw ?? "");
  if (result) {
    check(typeof result.unavailable === "string" && result.unavailable.length > 0,
          "Performance says why it is unavailable", result.unavailable ?? "(none)");
    check(result.totals.clients === null,
          "total clients is null, NOT 0", String(result.totals.clients));
    check(result.totals.active === null,
          "active clients is null, NOT 0", String(result.totals.active));
  }
}

/* ------------------------------------------------------- Clients overview - */
{
  const originals = {
    ch: process.env.CLIENT_HEALTH_URL,
    mi: process.env.MASTER_INBOX_URL,
    an: process.env.ANALYTICS_URL,
  };
  process.env.CLIENT_HEALTH_URL = DEAD;
  process.env.MASTER_INBOX_URL = DEAD;
  process.env.ANALYTICS_URL = DEAD;
  const { getClientsOverview } = await import("@/lib/clients/overview.ts?dead=1");
  let result = null, threw = null;
  try { result = await getClientsOverview(); } catch (e) { threw = e.message; }
  Object.assign(process.env, {
    CLIENT_HEALTH_URL: originals.ch, MASTER_INBOX_URL: originals.mi, ANALYTICS_URL: originals.an,
  });

  check(!threw, "the Clients roster does not throw with all three tools down", threw ?? "");
  if (result) {
    check(result.rows.length > 0,
          "it still lists the clients — the roster is the workspace's own",
          `${result.rows.length} rows`);
    const states = Object.values(result.tools);
    check(states.every((t) => typeof t.unavailable === "string" && t.unavailable),
          "every tool column says it is unavailable",
          states.map((t) => `${t.label}: ${String(t.unavailable).slice(0, 26)}`).join(" · "));
    const row = result.rows[0];
    check(row.health.plan === null && row.health.weeklyTarget === null,
          "Client Health figures are null, NOT 0",
          `plan=${row.health.plan} target=${row.health.weeklyTarget}`);
    check(row.inbox.intros === null,
          "introductions is null, NOT 0 — never 'nobody was introduced'",
          String(row.inbox.intros));
    check(row.analytics.campaigns === null && row.analytics.sent === null,
          "Analytics figures are null, NOT 0",
          `campaigns=${row.analytics.campaigns} sent=${row.analytics.sent}`);
    check(result.rows.every((r) => !r.health.present && !r.inbox.present && !r.analytics.present),
          "no client is claimed present in a tool that could not be read");
  }
}

console.log(`\n  ${pass} passed · ${fail} failed\n`);
process.exit(fail ? 1 : 0);
