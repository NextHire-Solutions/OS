import "server-only";

import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { getSupabase as getHealthSupabase } from "@/lib/tools/client-health/supabase";
import { isAdminUser } from "@/lib/identity/admin-db";

import { marketWords, relinkPlan, tokens } from "./campaign-portal-plan";
import { assignAutoRoutes } from "./campaign-portals";
import { getMasterClientList } from "./master-list";
import { miRowsFor } from "./mi-status-mirror";
import { postToMasterInbox } from "./onboard-run";
import { osTable } from "./os-db";
import { withStandardFlags } from "./portal-features";

/*
 * ADD A PORTAL TO A CLIENT (1 Oct) — a client opening a new market gets a
 * second (third…) portal instead of becoming a second client.
 *
 * The portal is created exactly as onboarding creates one: Master Inbox's own
 * POST /api/clients (new login-free link, sidebar list, Unknown threads
 * re-tagged), then the nine standard portal features. It is named
 * "<client> <market>" — "Properties & Estates Orlando" — and that name is
 * added to the client's aliases, which is how the OS knows the portal belongs
 * to the client (miRowsFor), and how Introduce finds the client for its leads.
 * It is also added to the client's names in Client Health, whose sync counts
 * a portal's introductions under the client that lists the portal's name.
 *
 * Then campaigns re-link by name: every campaign whose portal was chosen
 * AUTOMATICALLY and whose name mentions the new market moves to the new
 * portal. A choice a person made is never changed. Only new replies follow;
 * leads already in a portal stay there.
 */

export class AddPortalError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "AddPortalError"; }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface AddPortalPreview {
  name: string;
  /** Campaigns whose new replies would go to the new portal. */
  moves: string[];
  /** Campaigns that mention the market but keep a portal a person chose. */
  keptManual: string[];
}

async function context(osClientId: string) {
  const list = await getMasterClientList();
  const c = list.clients.find((x) => x.id === osClientId);
  if (!c) throw new AddPortalError("No such client.", 404);
  const { data: row, error } = await osTable("os_clients").select("name, aliases, mi_client_id, status").eq("id", osClientId).maybeSingle();
  if (error) throw new Error(error.message);
  const r = row as { name: string; aliases: string[] | null; mi_client_id: string | null; status: string } | null;
  if (!r) throw new AddPortalError("No such client.", 404);
  return { c, row: r };
}

function cleanMarket(input: unknown): string {
  const m = typeof input === "string" ? input.replace(/\s+/g, " ").trim() : "";
  if (m.length < 2 || m.length > 40) throw new AddPortalError("Enter the market, 2 to 40 characters — for example Orlando.");
  if (!/^[\p{L}\p{N}][\p{L}\p{N} &.'+-]*$/u.test(m)) throw new AddPortalError("The market can use letters, numbers, spaces and & . ' + - only.");
  return m;
}

export async function previewPortal(osClientId: string, marketInput: unknown): Promise<AddPortalPreview> {
  const market = cleanMarket(marketInput);
  const { c, row } = await context(osClientId);
  const name = `${row.name} ${market}`;
  if (!marketWords(name, [row.name]).length) throw new AddPortalError(`“${market}” is already part of the client's name; use the market's own name.`);
  const { data: all, error } = await getMasterInboxSupabase().from("clients").select("name");
  if (error) throw new Error(`Master Inbox: ${error.message}`);
  if (((all ?? []) as { name: string }[]).some((x) => norm(x.name) === norm(name))) {
    throw new AddPortalError(`A portal named “${name}” already exists.`, 409);
  }
  const routes = (await osTable("os_campaign_portals").select("campaign_name, source").eq("os_client_id", osClientId)).data as { campaign_name: string | null; source: string }[] | null;
  const words = new Set(marketWords(name, [row.name]));
  const mentions = (n: string | null) => tokens(n).some((t) => words.has(t));
  const campaigns = (c.campaigns ?? []).map((x) => x.name);
  const manual = new Set((routes ?? []).filter((r) => r.source === "manual").map((r) => r.campaign_name));
  return {
    name,
    moves: campaigns.filter((n) => mentions(n) && !manual.has(n)),
    keptManual: campaigns.filter((n) => mentions(n) && manual.has(n)),
  };
}

export async function addPortal(osClientId: string, marketInput: unknown, by: string): Promise<{ portal: { id: string; name: string; url: string | null }; relinked: number; note: string | null }> {
  if (!(await isAdminUser(by))) throw new AddPortalError("Only workspace admins can add a portal — it creates a live client-facing link.", 403);
  const preview = await previewPortal(osClientId, marketInput);
  const { row } = await context(osClientId);
  if (row.status === "paused" || row.status === "churned") {
    throw new AddPortalError(`${row.name} is ${row.status}; set it Active before adding a portal.`);
  }

  // 1. Claim the name on the client first — reversible, unlike the portal.
  const before = row.aliases ?? [];
  const aliases = before.some((a) => norm(a) === norm(preview.name)) ? before : [...before, preview.name];
  const { error: aErr } = await osTable("os_clients").update({ aliases, updated_at: new Date().toISOString() }).eq("id", osClientId);
  if (aErr) throw new Error(`Could not add the portal's name to the client: ${aErr.message}`);

  // 2. The portal itself, through Master Inbox's own create route.
  let created: { id: string; name: string; portal_url: string | null };
  try {
    const res = await postToMasterInbox("/api/clients", { name: preview.name, aliases: [] });
    const client = (res.body as { client?: { id?: string; name?: string; portal_url?: string | null } } | null)?.client;
    if (res.status < 200 || res.status >= 300 || !client?.id) {
      throw new AddPortalError(`Master Inbox refused: ${(res.body as { error?: string } | null)?.error ?? `HTTP ${res.status}`}`, 502);
    }
    created = { id: client.id, name: client.name ?? preview.name, portal_url: client.portal_url ?? null };
  } catch (e) {
    await osTable("os_clients").update({ aliases: before }).eq("id", osClientId); // undo step 1
    throw e;
  }
  console.log(`[add-portal] ${by} added portal ${created.name} (${created.id}) to ${row.name}`);

  // 3. The standard portal features, as onboarding sets them. Never fatal.
  let note: string | null = null;
  try {
    const db = getMasterInboxSupabase();
    const { data: r } = await db.from("clients").select("feature_flags").eq("id", created.id).maybeSingle();
    const { error } = await db.from("clients").update({ feature_flags: withStandardFlags(r?.feature_flags) }).eq("id", created.id);
    if (error) throw new Error(error.message);
  } catch (e) {
    note = `The portal works, but its standard features could not be switched on (${e instanceof Error ? e.message : String(e)}).`;
  }

  // 4. Client Health counts a portal's introductions under the client whose
  //    stored names include the portal's name (its sync's alias rule). Never
  //    fatal: the portal exists; the note says what to add by hand.
  try {
    const { data: link } = await osTable("os_clients").select("ch_client_id").eq("id", osClientId).maybeSingle();
    const chId = (link as { ch_client_id?: string | null } | null)?.ch_client_id;
    if (chId) {
      const ch = getHealthSupabase();
      const { data: chRow, error: rErr } = await ch.from("clients").select("campaign_aliases").eq("id", chId).maybeSingle();
      if (rErr) throw new Error(rErr.message);
      const have = ((chRow as { campaign_aliases?: string[] | null } | null)?.campaign_aliases ?? []);
      if (!have.some((a) => norm(a) === norm(created.name))) {
        const { error: wErr } = await ch.from("clients").update({ campaign_aliases: [...have, created.name] }).eq("id", chId);
        if (wErr) throw new Error(wErr.message);
      }
    }
  } catch (e) {
    note = `${note ? `${note} ` : ""}Client Health was not told about the new portal (${e instanceof Error ? e.message : String(e)}); add “${created.name}” to the client's aliases so its introductions count.`;
  }

  getMasterClientList.invalidate?.();
  const relinked = await relinkForNewPortal(osClientId, created.id);
  return { portal: { id: created.id, name: created.name, url: created.portal_url }, relinked, note };
}

/**
 * After a portal is added: campaigns with no choice yet get one (the client
 * may have had a single portal until now), and AUTOMATIC choices whose name
 * mentions the new market move to the new portal. Manual choices stay.
 */
export async function relinkForNewPortal(osClientId: string, newPortalId: string): Promise<number> {
  await assignAutoRoutes(osClientId);
  const { c, row } = await context(osClientId);
  const ids = await miRowsFor({ id: c.id, name: row.name, aliases: row.aliases ?? [], miClientId: row.mi_client_id });
  const { data: portals } = await getMasterInboxSupabase().from("clients").select("id, name").in("id", ids);
  const list = (portals ?? []) as { id: string; name: string }[];
  if (!list.some((p) => p.id === newPortalId)) return 0;
  const { data: routes } = await osTable("os_campaign_portals")
    .select("platform, campaign_id, campaign_name, mi_client_id, source").eq("os_client_id", osClientId).eq("source", "auto");
  const move = relinkPlan(
    ((routes ?? []) as { platform: string; campaign_id: string; campaign_name: string | null; mi_client_id: string; source: "auto" | "manual" }[])
      .map((r) => ({ campaignId: `${r.platform}:${r.campaign_id}`, campaignName: r.campaign_name, portalId: r.mi_client_id, source: r.source })),
    list, [row.name], row.mi_client_id ?? list[0].id, newPortalId,
  );
  let moved = 0;
  for (const key of move) {
    const [platform, campaignId] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const { data, error } = await osTable("os_campaign_portals")
      .update({ mi_client_id: newPortalId, decided_at: new Date().toISOString() })
      .eq("platform", platform).eq("campaign_id", campaignId).eq("source", "auto").select("campaign_id");
    if (!error && data?.length) moved++;
  }
  return moved;
}
