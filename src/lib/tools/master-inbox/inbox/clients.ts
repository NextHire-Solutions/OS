import { cache } from "react";
import { createServerSupabase } from "@/lib/supabase/server";
import { ttlCache } from "@/lib/cache/ttl";

export interface ClientOption {
  id: string;
  name: string;
  slug: string;
}

// Returns every client row that has at least one thread in this workspace,
// sorted by name. Used by the FilterBuilder's "Clients" picker. Cheap —
// the clients table is a fixed catalog of ~24 rows in the BrokerStaffer
// singleton setup. We still inner-join to threads so the picker only
// surfaces clients the user can actually filter by (skips inactive seeded
// rows).
async function fetchClients(workspaceId: string): Promise<ClientOption[]> {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("threads")
    .select("client_id, clients:client_id(id, name, slug)")
    .eq("workspace_id", workspaceId)
    .not("client_id", "is", null);
  if (error || !data) return [];

  const seen = new Map<string, ClientOption>();
  for (const row of data) {
    const c = Array.isArray(row.clients) ? row.clients[0] : row.clients;
    if (!c?.id) continue;
    if (seen.has(c.id)) continue;
    seen.set(c.id, {
      id: c.id as string,
      name: c.name as string,
      slug: c.slug as string,
    });
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// 60s TTL — the client roster turns over rarely; the threads scan is
// expensive enough that re-running it once per render under concurrent
// load was the bulk of the inbox slowdown.
//
// Held in a module-level variable so mutation endpoints can call
// `.invalidate()` after a rename / delete. React's outer `cache()`
// wrapper doesn't proxy custom methods, so we keep the raw ttlCache
// reference separately.
const cachedFetchClients = ttlCache(fetchClients, { ttlMs: 60_000 });
export const loadClients = cache(cachedFetchClients);

// Drop the inbox client-list cache so the next render sees fresh
// names. Called from the rename + delete endpoints in
// `app/api/clients/[id]/route.ts` — without this, renames take up
// to 60s to appear in the inbox's Client filter dropdown.
export function invalidateInboxClientsCache(): void {
  cachedFetchClients.invalidate();
}
