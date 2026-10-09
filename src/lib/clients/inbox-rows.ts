import "server-only";

import { retagUnknownThreads } from "@/app/api/tools/master-inbox/clients/route";
import { invalidateInboxClientsCache } from "@/lib/inbox/clients";
import { publicPortalUrl } from "@/lib/portals/public-url";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { _invalidateClientCache } from "@/lib/tools/master-inbox/clients/derive";
import { getSupabase as getHealthSupabase } from "@/lib/tools/client-health/supabase";
import { assertPortalUrlStable } from "@/lib/tools/master-inbox/portal-guard";

import { planInboxRowEdit, type MasterLite, type RowEditPlan } from "./inbox-row-edit";
import { getMasterClientList } from "./master-list";
import { miRowsFor } from "./mi-status-mirror";
import { osTable } from "./os-db";
import { keyOf } from "./roster";

/*
 * A client's Master Inbox rows — one per portal — on its record (9 Oct).
 *
 * Master Inbox → Settings → Clients was the only place to rename a row or to
 * remove or replace a spelling; that tab is gone, and this is where it went,
 * scoped to the client being looked at. The rules are in inbox-row-edit.ts.
 *
 * The write mirrors the tool's own PATCH /api/tools/master-inbox/clients/[id]
 * for name and aliases (slug from the name, the portal guard, saved lists
 * renamed, Unknown threads re-tagged) and deliberately does not call it: that
 * route also carries the portal on/off switch, and is left exactly as it is.
 */

export interface InboxRowView {
  id: string;
  name: string;
  aliases: string[];
  /** Conversations filed under this row. */
  threads: number | null;
  /** Its portal link, when it has one. */
  url: string | null;
  enabled: boolean;
  /** The row the master record links to (os_clients.mi_client_id). */
  main: boolean;
}

type MiRow = { id: string; name: string; slug: string | null; aliases: string[] | null; portal_token: string | null; portal_enabled: boolean | null };
type OsRow = { id: string; name: string; aliases: string[] | null; mi_client_id: string | null; ch_client_id: string | null };

export class InboxRowError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "InboxRowError"; }
}

async function load(clientId: string) {
  const mi = createAdminSupabase();
  const [{ data: os, error: osErr }, { data: rows, error: miErr }] = await Promise.all([
    osTable("os_clients").select("id, name, aliases, mi_client_id, ch_client_id"),
    mi.from("clients").select("id, name, slug, aliases, portal_token, portal_enabled").limit(1000),
  ]);
  if (osErr) throw new InboxRowError(osErr.message, 502);
  if (miErr) throw new InboxRowError(miErr.message, 502);
  const clients = (os ?? []) as unknown as OsRow[];
  const all = (rows ?? []) as unknown as MiRow[];
  const client = clients.find((c) => c.id === clientId);
  if (!client) throw new InboxRowError("No such client", 404);
  const ids = await miRowsFor({ id: client.id, name: client.name, aliases: client.aliases ?? [], miClientId: client.mi_client_id });
  const mine = all.filter((r) => ids.includes(r.id));
  return { mi, client, clients, all, mine };
}

/** The client's inbox rows with their spellings and conversation counts. */
export async function inboxRowsFor(clientId: string): Promise<InboxRowView[]> {
  const { mi, client, mine } = await load(clientId);
  const counts = await Promise.all(mine.map(async (r) => {
    const { count, error } = await mi.from("threads").select("id", { count: "exact", head: true }).eq("client_id", r.id);
    return error ? null : count ?? 0;
  }));
  return mine
    .map((r, i) => ({
      id: r.id, name: r.name, aliases: r.aliases ?? [], threads: counts[i],
      url: r.portal_token ? publicPortalUrl(r.portal_token) : null,
      enabled: r.portal_enabled !== false,
      main: r.id === client.mi_client_id,
    }))
    .sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name));
}

const toSlug = (name: string): string =>
  name.toLowerCase().trim().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "client";

/**
 * Plan — and unless `dryRun`, make — a rename or a change of spellings on one
 * of the client's rows. Refuses a row that is not this client's.
 */
export async function editInboxRow(
  clientId: string,
  rowId: string,
  change: { name?: string; aliases?: string[] },
  who: string,
  dryRun: boolean,
): Promise<RowEditPlan & { saved: boolean; warnings: string[] }> {
  const { mi, client, clients, all, mine } = await load(clientId);
  const row = mine.find((r) => r.id === rowId);
  if (!row) throw new InboxRowError("That Master Inbox row is not this client's.", 400);
  const lite = (c: OsRow): MasterLite => ({ id: c.id, name: c.name, aliases: c.aliases });
  const plan = planInboxRowEdit({
    row: { id: row.id, name: row.name, slug: row.slug, aliases: row.aliases },
    client: lite(client), rows: all.map((r) => ({ id: r.id, name: r.name, slug: r.slug, aliases: r.aliases })),
    clients: clients.map(lite), name: change.name, aliases: change.aliases,
  });
  if (dryRun || !plan.ok) return { ...plan, saved: false, warnings: [] };

  // 1. Master Inbox: name (and the slug derived from it) and aliases. Never the token.
  const update: Record<string, unknown> = {};
  if (plan.update.name !== undefined) { update.name = plan.update.name; update.slug = toSlug(plan.update.name); }
  if (plan.update.aliases !== undefined) update.aliases = plan.update.aliases;
  assertPortalUrlStable(update);
  const { error } = await mi.from("clients").update(update).eq("id", row.id);
  if (error) {
    throw new InboxRowError(error.code === "23505" ? "Another Master Inbox row already has that name." : error.message, error.code === "23505" ? 409 : 502);
  }
  console.log(`[inbox-rows] ${who} edited Master Inbox row "${row.name}" of ${client.name}: ${JSON.stringify(plan.update)}`);
  _invalidateClientCache();
  invalidateInboxClientsCache();

  const warnings: string[] = [];
  // Saved lists named after the row follow a rename (the tool's PATCH does the same).
  if (plan.update.name !== undefined) {
    const { error: lErr } = await mi.from("lists").update({ name: plan.update.name, updated_at: new Date().toISOString() }).eq("client_id", row.id);
    if (lErr) warnings.push(`The inbox's saved list for this client still shows the old name (${lErr.message}).`);
  }
  // Conversations in Unknown may match the new name or spellings now.
  try { await retagUnknownThreads(mi, row.id); } catch (e) { warnings.push(`Unknown conversations were not re-checked (${e instanceof Error ? e.message : String(e)}).`); }

  // 2. The client answers to the new name (OS aliases, and Client Health's, as Add portal does).
  if (plan.addToClient) {
    const name = plan.addToClient;
    const have = client.aliases ?? [];
    if (!have.some((a) => keyOf(a) === keyOf(name))) {
      const { error: aErr } = await osTable("os_clients").update({ aliases: [...have, name], updated_at: new Date().toISOString() }).eq("id", client.id);
      if (aErr) warnings.push(`"${name}" could not be added to ${client.name}'s spellings (${aErr.message}) — add it on the record so its portal stays linked.`);
    }
    if (client.ch_client_id) {
      try {
        const ch = getHealthSupabase();
        const { data: chRow, error: rErr } = await ch.from("clients").select("campaign_aliases").eq("id", client.ch_client_id).maybeSingle();
        if (rErr) throw new Error(rErr.message);
        const chHave = ((chRow as { campaign_aliases?: string[] | null } | null)?.campaign_aliases ?? []);
        if (!chHave.some((a) => keyOf(a) === keyOf(name))) {
          const { error: wErr } = await ch.from("clients").update({ campaign_aliases: [...chHave, name] }).eq("id", client.ch_client_id);
          if (wErr) throw new Error(wErr.message);
        }
      } catch (e) {
        warnings.push(`Client Health was not told the new name (${e instanceof Error ? e.message : String(e)}); its introductions count once "${name}" is one of its spellings there.`);
      }
    }
  }
  getMasterClientList.invalidate?.();
  return { ...plan, saved: true, warnings };
}
