import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { CLIENT_ENTRY_SOURCE } from "@/lib/tools/master-inbox/portals/intro-counts";
import { osClientForPortal, portalsOfClient, type World } from "@/lib/tools/master-inbox/relay/resolve";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

import { DEFAULT_LEAD_SOURCE, leadKey, periodWindow, type BillableLead, type LeadSource } from "./model.ts";

/*
 * Pay per lead — WHERE THE LEADS COME FROM (26 Oct 2026).
 *
 * A lead is each Interested reply (decided 27 Oct by the client; 31 Oct the
 * user: "we do not have to send conversations. interested lead means count
 * that in for payment"). The source is a plain function,
 *
 *   billableLeads(osClientId, periodStart, periodEnd) → [{ key, name, at, source }]
 *
 * (days are Eastern, YYYY-MM-DD, end exclusive; `key` is the dedupe key), and
 * there are three of them. Which one a client uses is its row's lead_source;
 * the default for new rows is DEFAULT_LEAD_SOURCE in model.ts — one line.
 *
 *   handoffs       (the "per lead" products, the default) each conversation
 *                  on the client's portals labelled "Interested" within the
 *                  period, once per agent — the label the AI and the team put
 *                  on an Interested reply. Nothing has to be sent to the
 *                  client for it to count. Stored as 'handoffs' (the CHECK in
 *                  migrations/0043): until 31 Oct a lead counted only once the
 *                  brokerage hand-off had emailed the reply to the client.
 *   introductions  each entry WE put in the client's portal: Master Inbox's
 *                  client_pipeline_entries rows on any of the client's
 *                  portals whose source is not "Client Entry" (the client's
 *                  own candidates — portals/intro-counts.ts), introduced
 *                  within the period.
 *   calls          (the "$500 / $1,000 per call" products, 26 Oct) each
 *                  conversation on the client's portals labelled "Meetings
 *                  Booked" within the period, once per agent — the label the
 *                  AI and the team use for a booked call. Not confirmed with
 *                  the client yet.
 *
 * Both only READ. The OS's own tables through osTable(); Master Inbox's
 * through its read-only client (supabase.ts). The dedupe — once per key in a
 * period, never a key already billed for this client in an earlier period —
 * is model.ts dedupeLeads, applied by billing.ts on every source alike.
 */

export type LeadSourceFn = (osClientId: string, periodStart: string, periodEnd: string) => Promise<BillableLead[]>;

type Row = Record<string, unknown>;
const PAGE = 1000;

async function allPages(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; from < 100 * PAGE; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`${what}: ${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const s = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * The client's portals (Master Inbox `clients` rows) — only the ones that are
 * THIS client's: a portal reached by name, alias or a campaign route is kept
 * only if the OS's own rule (osClientForPortal: linked first, then routes,
 * then a name that fits one client only) gives it to this client. Without
 * that, an alias equal to another client's portal name would bill this
 * client for the other's calls and introductions (audit, 26 Oct).
 */
async function portalsOf(osClientId: string): Promise<string[]> {
  const { data: rows, error } = await osTable("os_clients").select("id, name, aliases, mi_client_id");
  if (error) throw new Error(`os_clients: ${error.message}`);
  const clients = ((rows ?? []) as Row[]).map((c) => ({ id: s(c.id), name: s(c.name), aliases: Array.isArray(c.aliases) ? (c.aliases as string[]) : [], miClientId: s(c.mi_client_id) || null }));
  if (!clients.some((c) => c.id === osClientId)) return [];
  const { data: routes, error: rErr } = await osTable("os_campaign_portals").select("platform, campaign_id, os_client_id, mi_client_id");
  if (rErr) throw new Error(`os_campaign_portals: ${rErr.message}`);
  const mi = getMasterInboxSupabase();
  const portals = await allPages((from, to) => mi.from("clients").select("id, name, slug, aliases").order("id", { ascending: true }).range(from, to), "clients");
  const world: World = {
    portals: portals.map((p) => ({ id: s(p.id), name: s(p.name), slug: s(p.slug) || null, aliases: Array.isArray(p.aliases) ? (p.aliases as string[]) : [] })),
    clients,
    campaignPortals: ((routes ?? []) as Row[]).map((r) => ({ platform: s(r.platform), campaignId: s(r.campaign_id), osClientId: s(r.os_client_id), miClientId: s(r.mi_client_id) })),
    teamCampaigns: [],
  };
  return portalsOfClient(osClientId, world).filter((p) => osClientForPortal(p, world) === osClientId);
}

/** The other definition: the introductions we put in the client's portal, in the period. */
export const introductionLeads: LeadSourceFn = async (osClientId, periodStart, periodEnd) => {
  const portals = await portalsOf(osClientId);
  if (!portals.length) return [];
  const w = periodWindow({ start: periodStart, end: periodEnd });
  const mi = getMasterInboxSupabase();
  const rows = await allPages(
    (from, to) =>
      mi
        .from("client_pipeline_entries")
        .select("id, client_id, thread_id, lead_name, lead_email, source, introduced_at")
        .in("client_id", portals)
        .gte("introduced_at", w.from)
        .lt("introduced_at", w.to)
        .order("introduced_at", { ascending: true })
        .range(from, to),
    "client_pipeline_entries",
  );
  return rows
    // In code, not `.neq`: SQL's <> drops a NULL source, which intro-counts.ts counts as ours.
    .filter((r) => r.source !== CLIENT_ENTRY_SOURCE && s(r.introduced_at))
    .map((r) => {
      const email = leadKey(s(r.lead_email));
      return {
        key: email || `entry:${s(r.thread_id) || s(r.id)}`,
        name: s(r.lead_name).trim() || email || "Lead",
        at: new Date(s(r.introduced_at)).toISOString(),
        source: "introduction",
      };
    });
};

/** The labels that mark an Interested reply and a booked call (labels.name, as open-responses.ts and the relay read them). */
const INTERESTED_LABEL = "Interested";
const CALL_LABEL = "Meetings Booked";

/** Conversations of the client's portals given `label` in the period — each at the first time it was given it there. */
const labelLeads = (label: string, source: string): LeadSourceFn => async (osClientId, periodStart, periodEnd) => {
  const portals = new Set(await portalsOf(osClientId));
  if (!portals.size) return [];
  const w = periodWindow({ start: periodStart, end: periodEnd });
  const mi = getMasterInboxSupabase();
  const { data: labels, error } = await mi.from("labels").select("id").eq("name", label);
  if (error) throw new Error(`labels: ${error.message}`);
  const labelIds = ((labels ?? []) as Row[]).map((l) => s(l.id)).filter(Boolean);
  if (!labelIds.length) return [];
  const assigned = await allPages(
    (from, to) =>
      mi
        .from("label_assignments")
        .select("target_id, assigned_at")
        .eq("target_type", "thread")
        .in("label_id", labelIds)
        .gte("assigned_at", w.from)
        .lt("assigned_at", w.to)
        .order("assigned_at", { ascending: true })
        .order("target_id", { ascending: true })
        .range(from, to),
    "label_assignments",
  );
  // The first time each conversation was marked in the period.
  const firstAt = new Map<string, string>();
  for (const a of assigned) if (s(a.target_id) && !firstAt.has(s(a.target_id))) firstAt.set(s(a.target_id), s(a.assigned_at));
  const threads: Row[] = [];
  const ids = [...firstAt.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error: tErr } = await mi.from("threads").select("id, client_id, lead_id").in("id", ids.slice(i, i + 200));
    if (tErr) throw new Error(`threads: ${tErr.message}`);
    threads.push(...((data ?? []) as Row[]).filter((t) => portals.has(s(t.client_id))));
  }
  const leadIds = [...new Set(threads.map((t) => s(t.lead_id)).filter(Boolean))];
  const leads = new Map<string, Row>();
  for (let i = 0; i < leadIds.length; i += 200) {
    const { data, error: lErr } = await mi.from("leads").select("id, email, full_name").in("id", leadIds.slice(i, i + 200));
    if (lErr) throw new Error(`leads: ${lErr.message}`);
    for (const l of (data ?? []) as Row[]) leads.set(s(l.id), l);
  }
  return threads
    .map((t) => {
      const lead = leads.get(s(t.lead_id));
      const email = leadKey(s(lead?.email));
      return {
        key: email || `thread:${s(t.id)}`,
        name: s(lead?.full_name).trim() || email || "Agent",
        at: new Date(firstAt.get(s(t.id)) ?? w.from).toISOString(),
        source,
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
};

/** The "per lead" products: Interested replies. */
export const interestedLeads = labelLeads(INTERESTED_LABEL, "interested");
/** The "per call" products: booked calls. */
export const callLeads = labelLeads(CALL_LABEL, "call");

export const LEAD_SOURCES: Record<LeadSource, LeadSourceFn> = {
  handoffs: interestedLeads,
  introductions: introductionLeads,
  calls: callLeads,
};

/** The leads of a client in a period, by its chosen definition (or the default). Before dedupe. */
export function billableLeads(osClientId: string, periodStart: string, periodEnd: string, source: LeadSource = DEFAULT_LEAD_SOURCE): Promise<BillableLead[]> {
  return LEAD_SOURCES[source](osClientId, periodStart, periodEnd);
}
