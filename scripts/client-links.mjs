/*
 * The link matrix: which of the four tools each canonical client exists in.
 *
 *   node scripts/client-links.mjs [--json]
 *
 * READ ONLY. This writes nothing, anywhere. It is the dry run behind Phase 2
 * of CLIENTS-PLAN.md — the answer it prints is what would be stored as the
 * link columns on `os_clients`.
 */
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(),
                 l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

const { resolveLinks, TOOL_LABEL } = await import("../src/lib/clients/links.ts");
const report = await resolveLinks();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const TOOLS = ["masterInbox", "clientHealth", "analytics", "onboarding"];
const HEAD = { masterInbox: "Inbox", clientHealth: "Health", analytics: "Analytics", onboarding: "Onboard" };

for (const [tool, why] of Object.entries(report.unavailable)) {
  console.log(`  ⚠ ${TOOL_LABEL[tool]} could not be read — ${why}`);
}
console.log("");
console.log(`  ${"Client".padEnd(36)} ${TOOLS.map((t) => HEAD[t].padEnd(10)).join("")}`);
console.log(`  ${"─".repeat(36)} ${"─".repeat(40)}`);

const missingCount = Object.fromEntries(TOOLS.map((t) => [t, 0]));
for (const c of report.clients) {
  const cells = TOOLS.map((t) => {
    if (report.unavailable[t]) return "—".padEnd(10);
    if (c.ambiguous.includes(t)) return "AMBIG".padEnd(10);
    if (c.links[t]) return "✓".padEnd(10);
    missingCount[t]++;
    return "MISSING".padEnd(10);
  });
  console.log(`  ${c.name.padEnd(36)} ${cells.join("")}`);
}

console.log("");
console.log(`  ${report.clients.length} canonical clients`);
for (const t of TOOLS) {
  if (report.unavailable[t]) continue;
  const n = missingCount[t];
  console.log(`    ${TOOL_LABEL[t].padEnd(15)} ${n === 0 ? "all present" : `${n} missing`}`);
}
console.log("");
console.log("  Rows in each tool that no canonical client claims:");
for (const t of TOOLS) {
  if (report.unavailable[t]) continue;
  const list = report.unclaimed[t];
  console.log(`    ${TOOL_LABEL[t]} — ${list.length}`);
  for (const r of list) console.log(`        ${r.name}`);
}
