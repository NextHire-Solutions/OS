/*
 * Coverage of the cross-product client resolver, against the live estate.
 *
 * The number that matters is Agent Search: name-only matching reached 32 of
 * 42, and a miss there is answered as "no scrapes" rather than as a gap. This
 * reports what the resolver reaches now and names every client it cannot.
 */
import { resolveAll, findClient } from "../src/lib/tools/assistant/identity.ts";

const all = await resolveAll();
const pct = (n) => `${n}/${all.length}`;
const linked = (k) => all.filter((c) => c[k] != null).length;

console.log(`canonical roster: ${all.length} clients\n`);
console.log(`  analytics     ${pct(linked("analyticsClientId"))}`);
console.log(`  client health ${pct(linked("clientHealthId"))}`);
console.log(`  agent search  ${pct(linked("agentSearchClientId"))}`);

const full = all.filter((c) => c.missing.length === 0).length;
console.log(`\n  resolved in ALL products: ${pct(full)}`);

const gaps = all.filter((c) => c.missing.length);
console.log(`\nclients with a gap (${gaps.length}) — the assistant must disclose these, never answer 0:`);
for (const c of gaps.slice(0, 20)) {
  console.log(`  ${c.name.padEnd(34)} missing: ${c.missing.join(", ")}`);
}
if (gaps.length > 20) console.log(`  …and ${gaps.length - 20} more`);

console.log("\nfindClient, the way a person types it:");
for (const q of ["54 realty", "howe", "keyes", "camelot", "rise"]) {
  const { match, candidates } = await findClient(q);
  console.log(`  "${q}" → ${match ? match.name : `ambiguous: ${candidates.map((c) => c.name).join(" | ") || "no match"}`}`);
}
