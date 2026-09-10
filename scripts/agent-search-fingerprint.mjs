/*
 * Proves Agent Search's data was not damaged.
 *
 * Agent Search's database is the biggest thing the OS touches: 1.17M agents,
 * 1.33M agent↔MLS links, 178K offices. Its whole write model is ADDITIVE —
 * every scrape upserts, and the tool's own comments say so repeatedly
 * ("Re-scraping ACCUMULATES (adds/updates, never deletes)"). So the invariant
 * worth guarding is simple and strong:
 *
 *     NO TABLE MAY EVER SHRINK.
 *
 * A drop is not a regression to argue about, it is data loss. This also
 * records the nine Courted accounts by email with their MLS reach, because
 * losing an account's row in mls_monitor_state would silently stop it being
 * monitored, and nothing else would notice.
 *
 *   node scripts/agent-search-fingerprint.mjs save
 *   node scripts/agent-search-fingerprint.mjs check
 *
 * Read-only. It performs no writes of any kind.
 */
import fs from "node:fs";
import path from "node:path";

const OUT = process.env.FP_OUT || path.join(process.cwd(), ".agent-search-fingerprint.json");

function env() {
  const E = {};
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_0-9]+)\s*=\s*(.*)$/);
    if (m) E[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return E;
}

/*
 * The tables Agent Search's pipeline writes.
 *
 * `courted_agents` / `zillow_agents` / `realtor_agents` are in the tool's
 * schema.sql but DO NOT EXIST in the live database — db.js's persist path
 * fails silently and the real write path is the ingest webhook into `agents`.
 * They are listed anyway: if one ever appears, that is a change worth seeing.
 */
const TABLES = [
  "agents", "agent_mls", "offices", "mls", "saved_lists",
  "mls_monitor_state", "refresh_state",
  "courted_agents", "zillow_agents", "realtor_agents",
];

async function snapshot() {
  const E = env();
  const U = E.AGENT_SEARCH_SUPABASE_URL;
  const K = E.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY;
  if (!U || !K) throw new Error("AGENT_SEARCH_SUPABASE_URL / SERVICE_ROLE_KEY missing from .env.local");
  const H = { apikey: K, Authorization: `Bearer ${K}` };

  const counts = {};
  for (const t of TABLES) {
    const r = await fetch(`${U}/rest/v1/${t}?select=*`, {
      headers: { ...H, Prefer: "count=exact", Range: "0-0" },
    });
    // 404 = the table does not exist. Recorded as null, not 0, so "absent"
    // and "empty" stay distinguishable.
    counts[t] = r.status === 404 ? null
      : Number((r.headers.get("content-range") || "/0").split("/")[1]) || 0;
  }

  const acc = await fetch(`${U}/rest/v1/mls_monitor_state?select=email,total,scanned_at&order=email`, { headers: H });
  const accounts = acc.ok ? await acc.json() : [];
  const ref = await fetch(`${U}/rest/v1/refresh_state?select=email,last_refreshed_at,last_status&order=email`, { headers: H });
  const refresh = ref.ok ? await ref.json() : [];

  return { at: new Date().toISOString(), counts, accounts, refresh };
}

const mode = process.argv[2] || "check";
const now = await snapshot();
const fmt = (n) => (n === null ? "absent" : String(n));

if (mode === "save" || !fs.existsSync(OUT)) {
  fs.writeFileSync(OUT, JSON.stringify(now, null, 2));
  console.log(`  saved · ${now.accounts.length} Courted accounts`);
  for (const [t, n] of Object.entries(now.counts)) console.log(`    ${t.padEnd(20)} ${fmt(n).padStart(9)}`);
  process.exit(0);
}

const before = JSON.parse(fs.readFileSync(OUT, "utf8"));
const problems = [];

console.log(`  baseline ${before.at}`);
for (const [t, n] of Object.entries(now.counts)) {
  const was = before.counts?.[t];
  let note = "";
  if (was === undefined || was === null || n === null) {
    note = n === null ? " (absent)" : "";
    if (was === null && n !== null) problems.push(`table ${t} APPEARED (was absent, now ${n} rows)`);
  } else if (n < was) {
    note = ` (-${was - n})`;
    problems.push(`*** DATA LOSS: ${t} ${was} → ${n} (${was - n} rows fewer)`);
  } else {
    note = n === was ? " (unchanged)" : ` (+${n - was})`;
  }
  console.log(`    ${t.padEnd(20)} ${fmt(n).padStart(9)}${note}`);
}

const seen = new Map(before.accounts.map((a) => [a.email, a]));
for (const a of now.accounts) {
  const b = seen.get(a.email);
  if (!b) { problems.push(`NEW Courted account ${a.email} (not a fault, but new)`); continue; }
  // A shrinking reach means an account lost MLS access — the exact thing the
  // monitor exists to catch, so it must not pass silently here either.
  if (b.total != null && a.total != null && a.total < b.total) {
    problems.push(`*** MLS REACH FELL: ${a.email} ${b.total} → ${a.total} agents`);
  }
  seen.delete(a.email);
}
for (const [email] of seen) problems.push(`*** COURTED ACCOUNT GONE: ${email} is no longer monitored`);

console.log(`\n  ${now.accounts.length} Courted accounts · ${now.refresh.filter((r) => r.last_status === "ok").length} refreshed OK`);
if (problems.length === 0) {
  console.log("\n  ✅ no table shrank · no Courted account lost · no MLS reach fell");
  process.exit(0);
}
console.log("\n  ⚠️  DIFFERENCES:");
for (const p of problems) console.log(`     ${p}`);
process.exit(problems.some((p) => p.startsWith("***")) ? 1 : 0);
