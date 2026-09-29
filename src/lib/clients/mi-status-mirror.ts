import "server-only";

import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { osTable } from "./os-db";
import type { ClientStatus } from "./client-status";

/*
 * MASTER INBOX'S STATUS MIRROR — `clients.status` in Master Inbox.
 *
 * A column its migration 0001 added "recorded but not yet enforced": nothing
 * in Master Inbox reads it (portals follow the Client Health feed into
 * `portal_enabled`, lib/portals/status-sync.ts), and nothing kept it current,
 * so 13 clients read blank and a paused one read active — the last status
 * disagreement between the tools (30 Sep).
 *
 * This writes ONLY that column. Never `portal_enabled`, never a token, never
 * a name: the rows it touches are live portals, which is why os-db.ts keeps
 * this table out of `osTable()`. It covers the client's linked row and any
 * second portal row that carries the client's name or an alias, and never a
 * row linked to a different client.
 */

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Master Inbox rows that belong to this client: its linked row, plus second portals by name. */
export async function miRowsFor(client: { id: string; name: string; aliases?: string[]; miClientId: string | null }): Promise<string[]> {
  const keys = new Set([client.name, ...(client.aliases ?? [])].map(norm).filter(Boolean));
  const [{ data: rows, error }, { data: links, error: lErr }] = await Promise.all([
    getMasterInboxSupabase().from("clients").select("id, name, slug"),
    osTable("os_clients").select("id, mi_client_id"),
  ]);
  if (error) throw new Error(error.message);
  if (lErr) throw new Error(lErr.message);
  const linkedElsewhere = new Set(
    ((links ?? []) as unknown as { id: string; mi_client_id: string | null }[])
      .filter((l) => l.mi_client_id && l.id !== client.id).map((l) => l.mi_client_id as string),
  );
  const ids = new Set<string>();
  if (client.miClientId) ids.add(client.miClientId);
  for (const r of (rows ?? []) as { id: string; name: string; slug: string }[]) {
    if (r.slug === "unknown" || linkedElsewhere.has(r.id)) continue;
    if (keys.has(norm(r.name))) ids.add(r.id);
  }
  return [...ids];
}

/** Write the status onto those rows, and nothing else. Returns how many rows took it. */
export async function writeMiStatusMirror(ids: string[], status: ClientStatus): Promise<number> {
  if (!ids.length) return 0;
  const { data, error } = await getMasterInboxSupabase().from("clients").update({ status }).in("id", ids).select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}

/**
 * Analytics rows for the same client beyond its linked one — a second
 * portal's row ("SERHANT. PA 15M+"), matched by the client's name or alias,
 * never a row linked to another client. They take the client's status so a
 * paused client is not still counted active through its second portal.
 */
export async function analyticsSecondRows(client: { id: string; name: string; aliases?: string[]; anClientId: string | null }): Promise<string[]> {
  const { getAnalyticsSupabase } = await import("@/lib/tools/analytics/supabase");
  const keys = new Set([client.name, ...(client.aliases ?? [])].map(norm).filter(Boolean));
  const [{ data: rows, error }, { data: links, error: lErr }] = await Promise.all([
    getAnalyticsSupabase().from("clients").select("id, name"),
    osTable("os_clients").select("id, an_client_id"),
  ]);
  if (error) throw new Error(error.message);
  if (lErr) throw new Error(lErr.message);
  const linked = new Set(((links ?? []) as unknown as { an_client_id: string | null }[]).map((l) => l.an_client_id).filter(Boolean));
  return ((rows ?? []) as { id: string; name: string }[])
    .filter((r) => r.id !== client.anClientId && !linked.has(r.id) && keys.has(norm(r.name)))
    .map((r) => r.id);
}
