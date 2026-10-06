import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";
import { getCorofySupabase } from "@/lib/tools/corofy/supabase";

import { viewsByClient, type ClientView, type ViewLink, type ViewRow } from "./saved-views-match";

/*
 * Each client's Database saved views (client feedback, 6 Oct). Reads the
 * Database's saved_lists (read-only) and the OS's own links (0030), and
 * matches them in saved-views-match.ts.
 */

async function loadViews(): Promise<ViewRow[]> {
  const { data, error } = await getCorofySupabase().from("saved_lists").select("id, name, filters, cached_count").limit(5000);
  if (error) throw new Error(`Database saved views: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; name: string | null; filters: Record<string, unknown> | null; cached_count: number | null }>).map((v) => {
    const f = v.filters ?? {};
    const ids = [f.orchClientId, ...(Array.isArray(f.orchClientIds) ? f.orchClientIds : [])].filter((x): x is string => typeof x === "string" && !!x);
    return { id: String(v.id), name: v.name ?? "(untitled)", agents: typeof v.cached_count === "number" ? v.cached_count : null, orchClientIds: ids };
  });
}
export const getSavedViews = ttlCache(loadViews, { ttlMs: 5 * 60_000, staleMs: 30 * 60_000, key: () => "views", shared: "database-saved-views" });

export async function listViewLinks(): Promise<{ links: ViewLink[]; ready: boolean }> {
  const { data, error } = await osTable("os_client_saved_views").select("os_client_id, saved_list_id, excluded");
  if (error) return { links: [], ready: false };
  return {
    ready: true,
    links: ((data ?? []) as Array<{ os_client_id: string; saved_list_id: string; excluded: boolean }>).map((l) => ({ clientId: l.os_client_id, viewId: l.saved_list_id, excluded: !!l.excluded })),
  };
}

export async function savedViewsByClient(): Promise<{ byClient: Record<string, ClientView[]>; views: Array<{ id: string; name: string }>; linksReady: boolean }> {
  const [views, { links, ready }, clientsRes] = await Promise.all([
    getSavedViews(),
    listViewLinks(),
    osTable("os_clients").select("id, name, aliases, orch_client_id"),
  ]);
  if (clientsRes.error) throw new Error(`os_clients: ${clientsRes.error.message}`);
  const clients = ((clientsRes.data ?? []) as unknown as Array<{ id: string; name: string; aliases: string[] | null; orch_client_id: string | null }>)
    .map((c) => ({ id: c.id, name: c.name, aliases: c.aliases ?? [], orchClientId: c.orch_client_id }));
  const map = viewsByClient(clients, views, links);
  return {
    byClient: Object.fromEntries(map),
    views: views.map((v) => ({ id: v.id, name: v.name })).sort((a, b) => a.name.localeCompare(b.name)),
    linksReady: ready,
  };
}
