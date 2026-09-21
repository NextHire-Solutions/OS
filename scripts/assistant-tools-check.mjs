/*
 * The three phase-1 tools, against the live estate.
 *
 * What this is really checking is that the figures are TRUE, not that the
 * code runs. Every count here is one a person could contradict by opening the
 * relevant screen, which is the only standard that matters for an assistant
 * that will be believed.
 */
import { findClientTool, clientOverviewTool, clientRankingsTool } from "../src/lib/tools/assistant/tools.ts";

console.log("=== find_client ===");
for (const q of ["54 realty", "howe", "rise", "not a real client"]) {
  const r = await findClientTool(q);
  console.log(`  "${q}" → ${r.match ? r.match.name : `(${r.candidates.length} candidates)`}${r.note ? "  — " + r.note.slice(0, 74) : ""}`);
}

console.log("\n=== client_overview: The Keyes Company ===");
const ov = await clientOverviewTool("The Keyes Company");
console.log(JSON.stringify(ov, null, 1).slice(0, 1400));

console.log("\n=== client_overview: a client with a known gap ===");
const gap = await clientOverviewTool("Brooklyn Group");
if ("client" in gap) {
  console.log(`  ${gap.client.name} — missing: ${gap.missing.join(", ") || "nothing"}`);
  console.log(`  scraping: ${gap.scraping === null ? "null (not linked — NOT zero)" : JSON.stringify(gap.scraping)}`);
  console.log(`  health  : ${gap.health === null ? "null" : `intros ${gap.health.introsThisMonth}/${gap.health.monthlyTarget}`}`);
}

for (const signal of ["behind_target", "gone_quiet", "stagnant_intros"]) {
  const r = await clientRankingsTool({ signal, limit: 5 });
  if ("error" in r) { console.log(`\n=== ${signal} === ERROR ${r.error}`); continue; }
  console.log(`\n=== worst by ${signal} (${r.clients.length} of ${r.clients.length + 0}) ===`);
  for (const c of r.clients) {
    console.log(`  ${c.name.slice(0, 30).padEnd(32)} intros ${String(c.introsThisMonth ?? "-").padStart(3)}/${String(c.monthlyTarget ?? "-").padEnd(3)} vs ${String(c.vsTarget ?? "-").padStart(4)}  quiet ${String(c.daysSinceLeadActivity ?? "-").padStart(4)}d  stagnant ${String(c.stagnantIntros ?? "-").padStart(3)}`);
  }
  if (signal === "behind_target") console.log(`  not covered by Client Health: ${r.notCovered.length} clients`);
}
