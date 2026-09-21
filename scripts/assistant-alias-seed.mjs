/*
 * Writes the aliases a person has confirmed. DRY RUN unless APPLY=1.
 *
 * Only pairs that are the same company spelled differently — a slash, a space
 * inside a word, a truncated name. Anything requiring judgement about whether
 * two companies are one is left out and reported for a human.
 */
import { createAdminSupabase } from "../src/lib/supabase/admin.ts";
import { getCorofySupabase } from "../src/lib/tools/corofy/supabase.ts";
import { resolveAll, normaliseName } from "../src/lib/tools/assistant/identity.ts";

/** our roster name → the spelling Agent Search uses */
const CONFIRMED = [
  ["RE/MAX Pacific", "REMAX Pacific", "the slash becomes a space: 're max' vs 'remax'"],
  ["JPAR Iron Horse Real Estate", "JPAR Ironhorse Real Estate", "'Iron Horse' vs 'Ironhorse'"],
  ["The RE Home Group of Douglas Realty", "The RE Home Group of Douglas Re", "the Agent Search name is truncated"],
  // Confirmed by the owner: one company, two spellings.
  ["Momentum Realty", "Momentum Lux Realty", "confirmed by the owner as the same company"],
];

const apply = process.env.APPLY === "1";
const roster = await resolveAll();
const { data: orchRows } = await getCorofySupabase().from("orch_clients").select("id, client_name");
const orchByName = new Map((orchRows ?? []).map((o) => [normaliseName(o.client_name), String(o.id)]));
const admin = createAdminSupabase();

for (const [ourName, theirName, why] of CONFIRMED) {
  const client = roster.find((c) => c.name === ourName);
  if (!client) { console.log(`  SKIP  ${ourName} — not in the roster`); continue; }
  if (client.agentSearchClientId) { console.log(`  SKIP  ${ourName} — already linked`); continue; }
  if (!orchByName.has(normaliseName(theirName))) { console.log(`  SKIP  ${ourName} — "${theirName}" not found in Agent Search`); continue; }

  console.log(`  ${apply ? "WRITE" : "would write"}  ${ourName}  ←→  "${theirName}"   (${why})`);
  if (apply) {
    const { error } = await admin.from("os_client_aliases").insert({
      client_id: client.id,
      source: "agent_search",
      alias: theirName.trim().toLowerCase(),
      confirmed_by: "reviewed against orch_clients",
      note: why,
    });
    if (error) console.log(`      FAILED: ${error.message}`);
  }
}
if (!apply) console.log("\n  dry run — set APPLY=1 to write");
