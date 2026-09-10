/*
 * Proves the client portals were not changed.
 *
 * Every live portal is addressed by `clients.portal_token`. This records the
 * token, the enabled flag and the slug for every client, and on a second run
 * reports any difference. Run it before a change and after; a clean diff is
 * evidence rather than assurance.
 *
 *   node scripts/portal-fingerprint.mjs save
 *   node scripts/portal-fingerprint.mjs check
 *
 * Read-only. It performs no writes of any kind.
 */
import fs from "node:fs";
import path from "node:path";

const OUT = process.env.FP_OUT || path.join(process.cwd(), ".portal-fingerprint.json");

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
  const U = E.MASTER_INBOX_SUPABASE_URL;
  const K = E.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY;
  if (!U || !K) throw new Error("MASTER_INBOX_SUPABASE_URL / SERVICE_ROLE_KEY missing from .env.local");

  const r = await fetch(
    `${U}/rest/v1/clients?select=id,name,slug,portal_token,portal_enabled&order=name`,
    { headers: { apikey: K, Authorization: `Bearer ${K}` } },
  );
  if (!r.ok) throw new Error(`clients read failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();

  // Counted alongside the portals, because "no data loss" means these too.
  const counts = {};
  for (const t of ["threads", "messages", "client_pipeline_entries", "client_pipeline_notes",
                   "client_agents", "client_team_members", "client_dnc_entries", "label_assignments"]) {
    const q = await fetch(`${U}/rest/v1/${t}?select=id&limit=1`, {
      headers: { apikey: K, Authorization: `Bearer ${K}`, Prefer: "count=exact", Range: "0-0" },
    });
    counts[t] = Number((q.headers.get("content-range") || "/0").split("/")[1]) || 0;
  }

  return {
    at: new Date().toISOString(),
    clients: rows.map((c) => ({
      id: c.id, name: c.name, slug: c.slug,
      portal_token: c.portal_token, portal_enabled: c.portal_enabled,
    })),
    counts,
  };
}

const mode = process.argv[2] || "check";
const now = await snapshot();
const live = now.clients.filter((c) => c.portal_token && c.portal_enabled !== false);

if (mode === "save" || !fs.existsSync(OUT)) {
  fs.writeFileSync(OUT, JSON.stringify(now, null, 2));
  console.log(`  saved · ${now.clients.length} clients · ${live.length} live portals`);
  for (const [t, n] of Object.entries(now.counts)) console.log(`    ${t.padEnd(24)} ${n}`);
  process.exit(0);
}

const before = JSON.parse(fs.readFileSync(OUT, "utf8"));
const byId = new Map(before.clients.map((c) => [c.id, c]));
const problems = [];

for (const c of now.clients) {
  const b = byId.get(c.id);
  if (!b) { problems.push(`NEW client "${c.name}" (not a fault, but new)`); continue; }
  if (b.portal_token !== c.portal_token)
    problems.push(`*** URL CHANGED: "${c.name}" token ${b.portal_token} → ${c.portal_token}`);
  if (b.portal_enabled !== c.portal_enabled)
    problems.push(`*** PORTAL TOGGLED: "${c.name}" enabled ${b.portal_enabled} → ${c.portal_enabled}`);
  if (b.slug !== c.slug) problems.push(`slug changed: "${c.name}" ${b.slug} → ${c.slug}`);
  byId.delete(c.id);
}
for (const [, b] of byId) problems.push(`*** CLIENT DELETED: "${b.name}" — its portal is gone`);

for (const [t, n] of Object.entries(now.counts)) {
  const was = before.counts?.[t];
  if (was === undefined) continue;
  if (n < was) problems.push(`*** DATA LOSS: ${t} ${was} → ${n} (${was - n} rows fewer)`);
}

console.log(`  ${now.clients.length} clients · ${live.length} live portals · baseline ${before.at}`);
for (const [t, n] of Object.entries(now.counts)) {
  const was = before.counts?.[t];
  const d = was === undefined ? "" : n === was ? " (unchanged)" : n > was ? ` (+${n - was})` : ` (-${was - n})`;
  console.log(`    ${t.padEnd(24)} ${String(n).padStart(7)}${d}`);
}
if (problems.length === 0) {
  console.log("\n  ✅ every portal URL identical · no client removed · no table shrank");
  process.exit(0);
}
console.log("\n  ⚠️  DIFFERENCES:");
for (const p of problems) console.log(`     ${p}`);
process.exit(problems.some((p) => p.startsWith("***")) ? 1 : 0);
