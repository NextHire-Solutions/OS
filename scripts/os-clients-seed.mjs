/*
 * Seeds `os_clients` from the code roster, with each client's per-tool links.
 *
 *   node --import ./scripts/alias-hooks.mjs scripts/os-clients-seed.mjs          # dry run
 *   node --import ./scripts/alias-hooks.mjs scripts/os-clients-seed.mjs --apply  # writes
 *
 * Writes ONLY to public.os_clients in the Master Inbox project, through the
 * table-guarded client in src/lib/clients/os-db.ts. No tool is contacted, no
 * tool's table is touched, and no portal token is read or written.
 *
 * Idempotent by slug. `status` is set on insert only — a re-seed must never
 * move a client someone marked churned back to active.
 */
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(),
                 l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

const apply = process.argv.includes("--apply");
const { seedOsClients } = await import("../src/lib/clients/os-clients.ts");
const { TOOL_LABEL } = await import("../src/lib/clients/links.ts");

const r = await seedOsClients({ dryRun: !apply });

const TOOLS = ["masterInbox", "clientHealth", "analytics", "onboarding"];
const HEAD = { masterInbox: "Inbox", clientHealth: "Health", analytics: "Analytics", onboarding: "Onboard" };

console.log(r.dryRun ? "\n  DRY RUN — nothing was written\n" : "\n  APPLIED\n");
console.log(`  ${"Client".padEnd(36)} ${TOOLS.map((t) => HEAD[t].padEnd(10)).join("")}`);
console.log(`  ${"─".repeat(36)} ${"─".repeat(40)}`);
for (const row of r.rows) {
  const cells = TOOLS.map((t) => (row.links[t] ? "✓" : "—").padEnd(10));
  console.log(`  ${row.name.padEnd(36)} ${cells.join("")}`);
}

console.log("");
console.log(`  ${r.rows.length} clients · ${r.inserted} to insert · ${r.updated} to update`);
for (const t of TOOLS) {
  console.log(`    ${TOOL_LABEL[t].padEnd(15)} ${r.linked[t]}/${r.rows.length} linked`);
}
if (r.ambiguous.length) {
  console.log("\n  Ambiguous — no link stored, needs a human:");
  for (const a of r.ambiguous) console.log(`    ${a.name} → ${a.tools.map((t) => TOOL_LABEL[t]).join(", ")}`);
}
console.log(r.dryRun ? "\n  Re-run with --apply to write.\n" : "");
