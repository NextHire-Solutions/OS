/*
 * Does the Clients page tell the truth?
 *
 *   node scripts/data-parity-test.mjs [baseUrl]
 *
 * Every other suite checks that a screen RENDERS. None of them checks that the
 * numbers on it are right. A roster that draws beautifully and reports a
 * client's plan as "production" when Client Health says "partner" is worse
 * than a broken page: nobody goes looking for it.
 *
 * So this reads the workspace's own roster API and, for every client, compares
 * each figure against the tool that owns it — the tool's API, not our copy of
 * it. Any disagreement is a bug in the workspace, because the tool is the
 * source and the workspace is the mirror.
 */
import fs from "node:fs";

const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3210";

/*
 * `--self-test` corrupts ONE figure from the workspace before comparing, and
 * requires the run to fail.
 *
 * A parity check that always passes is indistinguishable from one that is not
 * comparing anything — the same trap that let a UI auditor report clean for
 * weeks while blind to three of its five rules. So the suite proves it can see
 * a disagreement before its clean result means anything.
 */
const SELF_TEST = process.argv.includes("--self-test");
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const { mintAnalyticsSession } = await import("../src/lib/connectors/upstream-auth/analytics-session.ts");
const { normaliseName } = await import("../src/lib/reconcile/names.ts");

const tok = await mintSso(env.BS_SSO_SECRET || env.AUTH_SECRET,
  { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });

/* ---- what the workspace says ------------------------------------------- */
const roster = await (await fetch(`${BASE}/api/workspace/roster`, { headers: { cookie: `bs_sso=${tok}` } })).json();
console.log(`  workspace roster: ${roster.rows.length} clients (source=${roster.source})\n`);

if (SELF_TEST) {
  const victim = roster.rows.find((r) => r.health.plan);
  if (!victim) { console.log("  no client with a plan to corrupt — cannot self-test"); process.exit(1); }
  victim.health.plan = victim.health.plan === "partner" ? "minimum" : "partner";
  console.log(`  self-test: corrupted "${victim.client.name}" plan → "${victim.health.plan}"`);
}

/* ---- what each tool says ------------------------------------------------ */
const chRows = (await (await fetch(`${env.CLIENT_HEALTH_URL.replace(/\/$/, "")}/api/clients`,
  { headers: { "x-admin-token": env.CLIENT_HEALTH_READ_TOKEN } })).json()).clients ?? [];
const chByKey = new Map(chRows.map((c) => [normaliseName(c.name), c]));

const anTok = await mintAnalyticsSession(env.ANALYTICS_AUTH_SECRET,
  env.ANALYTICS_SERVICE_EMAIL || "command-center@brokerstaffer.com");
const anRows = (await (await fetch(`${env.ANALYTICS_URL.replace(/\/$/, "")}/api/clients`,
  { headers: { cookie: `bsa_session=${anTok}` } })).json()).clients ?? [];
const anByKey = new Map(anRows.map((c) => [normaliseName(c.name), c]));

const miStats = (await (await fetch(`${env.MASTER_INBOX_URL.replace(/\/$/, "")}/api/clients/intro-stats`,
  { headers: { "x-admin-token": env.MASTER_INBOX_ADMIN_TOKEN } })).json()).stats ?? [];
const miByKey = new Map(miStats.map((s) => [normaliseName(s.client_name), s]));

/* ---- compare ------------------------------------------------------------ */
let checked = 0, wrong = 0;
const problems = [];

/** Match the tool's row the way the workspace does: canonical name, then aliases. */
const lookup = (map, row) => {
  const direct = map.get(normaliseName(row.client.name));
  if (direct) return direct;
  for (const a of row.client.aliases ?? []) {
    const hit = map.get(normaliseName(a));
    if (hit) return hit;
  }
  return undefined;
};

for (const row of roster.rows) {
  const name = row.client.name;

  // --- Client Health: plan, weekly target, derived status ---------------
  const ch = lookup(chByKey, row);
  if (ch) {
    checked += 3;
    if ((row.health.plan ?? null) !== (ch.plan ?? null)) {
      wrong++; problems.push(`${name}: plan — workspace "${row.health.plan}" vs Client Health "${ch.plan}"`);
    }
    if ((row.health.weeklyTarget ?? null) !== (ch.weekly_target ?? null)) {
      wrong++; problems.push(`${name}: weekly target — workspace ${row.health.weeklyTarget} vs Client Health ${ch.weekly_target}`);
    }
    // The workspace derives status the way the tool does: hidden beats paused.
    const expect = ch.hidden === true ? "churned" : ch.client_paused === true ? "paused" : "active";
    if (row.health.status !== expect) {
      wrong++; problems.push(`${name}: health status — workspace "${row.health.status}" vs derived "${expect}"`);
    }
  } else if (row.health.present) {
    wrong++; problems.push(`${name}: workspace says present in Client Health, but no row found`);
  }

  // --- Analytics: campaign count ----------------------------------------
  const an = lookup(anByKey, row);
  if (an) {
    checked++;
    if ((row.analytics.campaigns ?? 0) !== (an.campaignCount ?? 0)) {
      wrong++; problems.push(`${name}: campaigns — workspace ${row.analytics.campaigns} vs Analytics ${an.campaignCount}`);
    }
  } else if (row.analytics.present) {
    wrong++; problems.push(`${name}: workspace says present in Analytics, but no row found`);
  }

  // --- Master Inbox: introductions --------------------------------------
  const mi = lookup(miByKey, row);
  if (mi) {
    checked++;
    if ((row.inbox.intros ?? 0) !== (mi.count ?? 0)) {
      wrong++; problems.push(`${name}: introductions — workspace ${row.inbox.intros} vs Master Inbox ${mi.count}`);
    }
  } else if (row.inbox.present) {
    wrong++; problems.push(`${name}: workspace says present in Master Inbox, but no row found`);
  }
}

console.log(`  ${checked} figures compared against the tool that owns them`);
if (problems.length === 0) {
  console.log("  ✅ every number on the Clients page matches its source\n");
} else {
  console.log(`\n  ${problems.length} disagreement(s):\n`);
  for (const p of problems.slice(0, 25)) console.log(`    ✗ ${p}`);
  if (problems.length > 25) console.log(`    … and ${problems.length - 25} more`);
  console.log("");
}
if (SELF_TEST) {
  const caught = problems.some((p) => /plan —/.test(p));
  console.log(caught
    ? "  ✅ the corruption was caught — this suite can see a disagreement\n"
    : "  ✗ the corruption went UNNOTICED — a clean result here means nothing\n");
  process.exit(caught ? 0 : 1);
}
process.exit(wrong ? 1 : 0);
