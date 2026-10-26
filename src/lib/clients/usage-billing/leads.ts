import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { CLIENT_ENTRY_SOURCE } from "@/lib/tools/master-inbox/portals/intro-counts";
import { portalsOfClient, type World } from "@/lib/tools/master-inbox/relay/resolve";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

import { DEFAULT_LEAD_SOURCE, leadKey, periodWindow, type BillableLead, type LeadSource } from "./model.ts";

/*
 * Pay per lead — WHERE THE LEADS COME FROM (26 Oct 2026).
 *
 * WHAT COUNTS AS A BILLABLE LEAD IS NOT DECIDED YET — the client is being
 * asked. So the source is a plain function,
 *
 *   billableLeads(osClientId, periodStart, periodEnd) → [{ key, name, at, source }]
 *
 * (days are Eastern, YYYY-MM-DD, end exclusive; `key` is the dedupe key), and
 * there are three of them. Which one a client uses is its row's lead_source;
 * the default for new rows is DEFAULT_LEAD_SOURCE in model.ts — one line.
 *
 *   handoffs       (the default candidate) each Interested reply handed to
 *                  the client by the brokerage hand-off, once per agent:
 *                  os_brokerage_relays rows of this client with kind
 *                  'handoff', status 'sent', practice false, sent within the
 *                  period (migrations/0035, relay/relay.ts). Practice runs,
 *                  held, skipped, failed and bounced hand-offs never count.
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

/** The default candidate: Interested replies handed to the brokerage, live and sent, in the period. */
export const handoffLeads: LeadSourceFn = async (osClientId, periodStart, periodEnd) => {
  const w = periodWindow({ start: periodStart, end: periodEnd });
  const rows = await allPages(
    (from, to) =>
      osTable("os_brokerage_relays")
        .select("id, thread_id, agent_email, agent_name, sent_at")
        .eq("os_client_id", osClientId)
        .eq("kind", "handoff")
        .eq("status", "sent")
        .eq("practice", false)
        .gte("sent_at", w.from)
        .lt("sent_at", w.to)
        .order("sent_at", { ascending: true })
        .range(from, to),
    "os_brokerage_relays",
  );
  return rows
    .filter((r) => s(r.sent_at))
    .map((r) => {
      const email = leadKey(s(r.agent_email));
      return {
        key: email || `thread:${s(r.thread_id) || s(r.id)}`,
        name: s(r.agent_name).trim() || email || "Agent",
        at: new Date(s(r.sent_at)).toISOString(),
        source: "handoff",
      };
    });
};

/** The client's portals (Master Inbox `clients` rows): its link, its campaign → portal choices, its name and aliases. */
async function portalsOf(osClientId: string): Promise<string[]> {
  const { data: c, error } = await osTable("os_clients").select("id, name, aliases, mi_client_id").eq("id", osClientId).maybeSingle();
  if (error) throw new Error(`os_clients: ${error.message}`);
  if (!c) return [];
  const client = c as Row;
  const { data: routes, error: rErr } = await osTable("os_campaign_portals").select("platform, campaign_id, os_client_id, mi_client_id").eq("os_client_id", osClientId);
  if (rErr) throw new Error(`os_campaign_portals: ${rErr.message}`);
  const mi = getMasterInboxSupabase();
  const portals = await allPages((from, to) => mi.from("clients").select("id, name, slug, aliases").order("id", { ascending: true }).range(from, to), "clients");
  const world: World = {
    portals: portals.map((p) => ({ id: s(p.id), name: s(p.name), slug: s(p.slug) || null, aliases: Array.isArray(p.aliases) ? (p.aliases as string[]) : [] })),
    clients: [{ id: osClientId, name: s(client.name), aliases: Array.isArray(client.aliases) ? (client.aliases as string[]) : [], miClientId: s(client.mi_client_id) || null }],
    campaignPortals: ((routes ?? []) as Row[]).map((r) => ({ platform: s(r.platform), campaignId: s(r.campaign_id), osClientId: s(r.os_client_id), miClientId: s(r.mi_client_id) })),
    teamCampaigns: [],
  };
  return portalsOfClient(osClientId, world);
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

/** The label that marks a booked call (labels.name, as open-responses.ts and the relay read it). */
const CALL_LABEL = "Meetings Booked";

/** The "per call" products: conversations of the client's portals labelled Meetings Booked in the period. */
export const callLeads: LeadSourceFn = async (osClientId, periodStart, periodEnd) => {
  const portals = new Set(await portalsOf(osClientId));
  if (!portals.size) return [];
  const w = periodWindow({ start: periodStart, end: periodEnd });
  const mi = getMasterInboxSupabase();
  const { data: labels, error } = await mi.from("labels").select("id").eq("name", CALL_LABEL);
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
        source: "call",
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
};

export const LEAD_SOURCES: Record<LeadSource, LeadSourceFn> = {
  handoffs: handoffLeads,
  introductions: introductionLeads,
  calls: callLeads,
};

/** The leads of a client in a period, by its chosen definition (or the default). Before dedupe. */
export function billableLeads(osClientId: string, periodStart: string, periodEnd: string, source: LeadSource = DEFAULT_LEAD_SOURCE): Promise<BillableLead[]> {
  return LEAD_SOURCES[source](osClientId, periodStart, periodEnd);
}
