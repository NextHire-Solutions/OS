import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { keyOf } from "@/lib/clients/roster";
import type { Roster } from "./rosters";

/*
 * Rewrites each tool's rows to the name the MASTER RECORD uses.
 *
 * The pairwise comparison matches tool against tool by name. That reports one
 * client spelled two ways as two missing clients — "Douglas Elliman Los
 * Angeles" only in Master Inbox, "Douglas Elliman LA" only in Analytics — when
 * os_clients has recorded for weeks that they are the same client.
 *
 * Layer 1 of the architecture spec says every tool should reference the master
 * list rather than maintain its own. This is that, applied to the comparison:
 * resolve both sides through the master record first, and only then ask where
 * they differ.
 *
 * THE TOOL'S OWN SPELLING IS KEPT, on `meta.spelledAs`, because losing it
 * would hide the very drift worth fixing. The row stops being reported as a
 * missing client; it does not stop being visible.
 *
 * Fails open: if os_clients cannot be read, the rosters are returned untouched
 * and the comparison behaves exactly as it did before. A screen that compares
 * by name is worse than one that compares by master record, and far better
 * than one that shows nothing.
 */
export async function canonicaliseRosters(rosters: Roster[]): Promise<Roster[]> {
  let index: Map<string, string>;
  try {
    const { data, error } = await osTable("os_clients")
      .select("name, aliases")
      .limit(1000);
    if (error || !data) return rosters;
    index = new Map();
    for (const row of data as { name: string; aliases: string[] | null }[]) {
      const canonical = (row.name ?? "").trim();
      if (!canonical) continue;
      for (const spelling of [canonical, ...(row.aliases ?? [])]) {
        const k = keyOf(spelling ?? "");
        if (k && !index.has(k)) index.set(k, canonical);
      }
    }
  } catch {
    return rosters;
  }
  if (index.size === 0) return rosters;

  return rosters.map((roster) => ({
    ...roster,
    entries: roster.entries.map((entry) => {
      const canonical = index.get(keyOf(entry.name));
      if (!canonical || canonical === entry.name) return entry;
      return {
        ...entry,
        name: canonical,
        meta: { ...(entry.meta ?? {}), spelledAs: entry.name },
      };
    }),
  }));
}
