/*
 * Proposes alias rows for the Agent Search gap — and proposes only.
 *
 * Nothing is written. A wrong alias joins two clients' numbers under one name,
 * which is worse than the gap it closes, so each proposal is judged and the
 * uncertain ones are printed for a person to decide.
 */
import { resolveAll, normaliseName, nameStem } from "../src/lib/tools/assistant/identity.ts";
import { getCorofySupabase } from "../src/lib/tools/corofy/supabase.ts";

const roster = await resolveAll();
const unlinked = roster.filter((c) => !c.agentSearchClientId);

const { data } = await getCorofySupabase().from("orch_clients").select("id, client_name, status");
const orch = (data ?? []).map((o) => ({ id: String(o.id), name: String(o.client_name ?? ""), status: o.status }));
// Which Agent Search clients are already spoken for by an exact/stem match?
const taken = new Set(roster.map((c) => c.agentSearchClientId).filter(Boolean));
const free = orch.filter((o) => !taken.has(o.id));

console.log(`${roster.length} clients · ${roster.length - unlinked.length} already linked to Agent Search`);
console.log(`${unlinked.length} unlinked · ${free.length} Agent Search clients unclaimed\n`);

const safe = [];
const unsure = [];

for (const c of unlinked) {
  const ourStem = nameStem(c.name);
  const ourNorm = normaliseName(c.name);
  // A candidate must share the stem, or one name must contain the other.
  const hits = free.filter((o) => {
    const oStem = nameStem(o.name), oNorm = normaliseName(o.name);
    if (ourStem && oStem && ourStem === oStem) return true;
    if (ourNorm && oNorm && (ourNorm.startsWith(oNorm) || oNorm.startsWith(ourNorm))) return true;
    return false;
  });
  if (hits.length === 1) safe.push({ client: c, orch: hits[0] });
  else if (hits.length > 1) unsure.push({ client: c, hits });
}

console.log("SAFE — exactly one candidate, sharing a stem or a prefix:");
for (const { client, orch: o } of safe) {
  console.log(`  ${client.name.padEnd(34)} ←→  "${o.name}"  (${o.status})`);
}
console.log(`\nAMBIGUOUS — more than one candidate, a person must choose (${unsure.length}):`);
for (const { client, hits } of unsure) {
  console.log(`  ${client.name.padEnd(34)} → ${hits.map((h) => `"${h.name}"`).join(" | ")}`);
}
const none = unlinked.length - safe.length - unsure.length;
console.log(`\nNO CANDIDATE AT ALL: ${none} clients — Agent Search simply does not carry them.`);
console.log("\nUnclaimed Agent Search clients with no match here:");
const matched = new Set(safe.map((s) => s.orch.id));
for (const o of free.filter((o) => !matched.has(o.id)).slice(0, 12)) console.log(`  "${o.name}" (${o.status})`);
