/*
 * Proves Client Health's data was not damaged.
 *
 * Records every client's identity and the row count of each table, so a second
 * run can say whether anything was lost. Run it before touching the screens and
 * again afterwards; a clean diff is evidence, not assurance.
 *
 *   node scripts/client-health-fingerprint.mjs save
 *   node scripts/client-health-fingerprint.mjs check
 *
 * READ-ONLY. It performs no writes of any kind — it is the thing you check a
 * write against, so it must never be part of what changed.
 *
 * The counts matter more than they look. `weekly_metrics` cascades when a
 * client is deleted, and `instantly_campaigns` / `bison_campaigns` lose rows
 * to the delete route's orphan cleanup. Those are the three tables where a
 * mistake would be quiet: nothing errors, the screen still renders, and a
 * client's history is simply shorter than it was.
 */
import fs from "node:fs";
import path from "node:path";

const OUT = process.env.FP_OUT || path.join(process.cwd(), ".client-health-fingerprint.json");

/** Tables whose row counts must never shrink unexpectedly. */
const TABLES = ["clients", "weekly_metrics", "instantly_campaigns", "bison_campaigns"];

function env() {
  const E = {};
  for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_0-9]+)\s*=\s*(.*)$/);
    if (m) E[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return E;
}

async function snapshot() {
  const E = env();
  const U = E.CLIENT_HEALTH_SUPABASE_URL;
  const K = E.CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY;
  if (!U || !K) {
    throw new Error("CLIENT_HEALTH_SUPABASE_URL / SERVICE_ROLE_KEY missing from .env.local");
  }
  const headers = { apikey: K, Authorization: `Bearer ${K}` };

  const r = await fetch(
    `${U}/rest/v1/clients?select=id,name,plan,weekly_target,monthly_target,hidden,client_paused,start_date,billing_anchor_date,time_zone&order=name`,
    { headers },
  );
  if (!r.ok) throw new Error(`clients read failed: ${r.status} ${await r.text()}`);
  const clients = await r.json();

  const counts = {};
  for (const t of TABLES) {
    const q = await fetch(`${U}/rest/v1/${t}?select=*&limit=1`, {
      headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
    });
    counts[t] = Number((q.headers.get("content-range") || "/0").split("/")[1]) || 0;
  }

  return { at: new Date().toISOString(), clients, counts };
}

const mode = process.argv[2] || "check";
const now = await snapshot();
const live = now.clients.filter((c) => !c.hidden && !c.client_paused);

const table = (counts, before) => {
  for (const t of TABLES) {
    const n = counts[t];
    const was = before?.[t];
    const d = was === undefined ? "" : n === was ? " (unchanged)" : n > was ? ` (+${n - was})` : ` (-${was - n})`;
    console.log(`    ${t.padEnd(22)} ${String(n).padStart(7)}${d}`);
  }
};

if (mode === "save" || !fs.existsSync(OUT)) {
  fs.writeFileSync(OUT, JSON.stringify(now, null, 2));
  console.log(`  saved · ${now.clients.length} clients · ${live.length} active`);
  table(now.counts);
  process.exit(0);
}

const before = JSON.parse(fs.readFileSync(OUT, "utf8"));
const byId = new Map(before.clients.map((c) => [c.id, c]));
const problems = [];
const changes = [];

for (const c of now.clients) {
  const b = byId.get(c.id);
  if (!b) {
    changes.push(`new client "${c.name}"`);
    continue;
  }
  for (const f of ["name", "plan", "weekly_target", "monthly_target", "hidden",
                   "client_paused", "start_date", "billing_anchor_date", "time_zone"]) {
    if (b[f] !== c[f]) changes.push(`"${c.name}" ${f}: ${b[f]} → ${c[f]}`);
  }
  byId.delete(c.id);
}
// A client that vanished is the one failure this script exists to catch.
for (const [, b] of byId) problems.push(`*** CLIENT DELETED: "${b.name}"`);

for (const t of TABLES) {
  const was = before.counts?.[t];
  if (was === undefined) continue;
  if (now.counts[t] < was) {
    problems.push(`*** ROWS LOST: ${t} ${was} → ${now.counts[t]} (${was - now.counts[t]} fewer)`);
  }
}

console.log(`  ${now.clients.length} clients · ${live.length} active · baseline ${before.at}`);
table(now.counts, before.counts);

if (changes.length) {
  console.log("\n  changes (not necessarily faults):");
  for (const c of changes) console.log(`     ${c}`);
}

if (problems.length === 0) {
  console.log("\n  ✅ no client removed · no table shrank");
  process.exit(0);
}
console.log("\n  ⚠️  PROBLEMS:");
for (const p of problems) console.log(`     ${p}`);
process.exit(1);
