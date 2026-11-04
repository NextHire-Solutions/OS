import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { CLIENT_ENTRY_SOURCE } from "@/lib/tools/master-inbox/portals/intro-counts";
import { osClientForPortal, portalsOfClient, type World } from "@/lib/tools/master-inbox/relay/resolve";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

import { DEFAULT_LEAD_SOURCE, easternMidnight, leadKey, periodWindow, type BillableLead, type LeadSource } from "./model.ts";

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
 *   handoffs       (the "per lead" products, the default) every conversation
 *                  on the client's portals EVER marked "Interested", counted in
 *                  the period it was first marked — interestedLeads, with the
 *                  user's rules of 2 Nov. Stored as 'handoffs' (the CHECK in
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

export type LeadSourceFn = (osClientId: string, periodStart: string, periodEnd: string, ctx?: { startDate?: string }) => Promise<BillableLead[]>;

/** A lead source that cannot be read yet (its table is missing) — nothing is billed, and the screen says why. */
export class LeadSourceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadSourceUnavailable";
  }
}

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

/*
 * THE "PER LEAD" PRODUCTS: INTERESTED REPLIES (2 Nov 2026 — the user's decisions).
 *
 * Master Inbox keeps ONE label per conversation: introducing an Interested reply DELETES its "Interested" label.
 * Counting the labels a conversation carries now therefore missed most real leads (of 183 marked Interested
 * 14 Oct – 2 Nov, 20 still carried it). So this reads label_history (Master Inbox migration 0080), which keeps
 * every label a conversation was ever given, and:
 *
 *   counts    every conversation of the client's portals EVER marked Interested ("Ever marked Interested"),
 *             in the period that holds the FIRST time it was marked — Introduction, No Show and the rest
 *             afterwards change nothing;
 *   not       one a person corrected to a 'no' label — its label NOW is one of CORRECTION_LABELS ("Not billed");
 *             one in Trash, or deleted;
 *             an agent already Interested or introduced for this client before its start date ("Don't bill"
 *             repeat agents): Interested or Introduction in the history, or an introduction in its portal,
 *             before the first period.
 *
 * Once per agent, ever: dedupeLeads / keysAlreadyBilled in billing.ts, on the agent's email. Read only.
 */
export const CORRECTION_LABELS: ReadonlySet<string> = new Set(["Not Interested", "Not Qualified", "Do Not Contact", "Unsubscribe", "Broker/Owner"]);
const INTRODUCTION_LABEL = "Introduction";
const HISTORY_MISSING = "Pay per lead needs Master Inbox migration 0080_label_history.sql run first — nothing is counted until then.";
const isMissingHistory = (message: string) => /label_history/.test(message) && /schema cache|does not exist|Could not find|relation/i.test(message);

async function chunked<T>(ids: readonly string[], size: number, read: (part: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) {
    const { data, error } = await read(ids.slice(i, i + size));
    if (error) {
      if (isMissingHistory(error.message)) throw new LeadSourceUnavailable(HISTORY_MISSING);
      throw new Error(`${what}: ${error.message}`);
    }
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

export const interestedLeads: LeadSourceFn = async (osClientId, periodStart, periodEnd, ctx) => {
  const portals = new Set(await portalsOf(osClientId));
  // No portal: nothing could ever be counted — said, never a silent "no leads" a person might close the period on.
  if (!portals.size) throw new LeadSourceUnavailable("This client has no Master Inbox portal linked, so no lead can be counted — link its portal first.");
  const w = periodWindow({ start: periodStart, end: periodEnd });
  const mi = getMasterInboxSupabase();

  // 1. Conversations marked Interested in the period.
  let marked: Row[];
  try {
    marked = await allPages(
      (from, to) => mi.from("label_history").select("thread_id").eq("label_name", INTERESTED_LABEL).gte("assigned_at", w.from).lt("assigned_at", w.to).order("assigned_at", { ascending: true }).order("id", { ascending: true }).range(from, to),
      "label_history",
    );
  } catch (e) {
    if (e instanceof Error && isMissingHistory(e.message)) throw new LeadSourceUnavailable(HISTORY_MISSING);
    throw e;
  }
  const candidates = [...new Set(marked.map((r) => s(r.thread_id)).filter(Boolean))];

  // 1b. The history is being kept: every conversation that carries "Interested" NOW, given in the period, is in it
  //     (the label and its history row are written together; re-applying a label keeps its time). One missing means
  //     the history stopped — counting on would miss leads, so nothing is counted until it's fixed.
  const { data: interestedIds, error: iErr } = await mi.from("labels").select("id").eq("name", INTERESTED_LABEL);
  if (iErr) throw new Error(`labels: ${iErr.message}`);
  const ids = ((interestedIds ?? []) as Row[]).map((l) => s(l.id)).filter(Boolean);
  if (ids.length) {
    const now = await allPages(
      (from, to) => mi.from("label_assignments").select("target_id").eq("target_type", "thread").in("label_id", ids).gte("assigned_at", w.from).lt("assigned_at", w.to).order("assigned_at", { ascending: true }).order("target_id", { ascending: true }).range(from, to),
      "label_assignments",
    );
    const recorded = new Set(candidates);
    const missing = now.filter((a) => !recorded.has(s(a.target_id))).length;
    if (missing) throw new LeadSourceUnavailable(`The label history is missing ${missing} conversation${missing === 1 ? "" : "s"} marked Interested in this period — it isn't being recorded, so nothing is counted until it's fixed (Master Inbox migration 0080).`);
  }
  if (!candidates.length) return [];

  // 2. Each one's FIRST time ever marked Interested — it counts only in the period that holds that moment.
  const firstAt = new Map<string, string>();
  for (const r of await chunked<Row>(candidates, 150, (part) => mi.from("label_history").select("thread_id, assigned_at").eq("label_name", INTERESTED_LABEL).in("thread_id", part), "label_history")) {
    const t = s(r.thread_id), at = s(r.assigned_at);
    if (t && at && (!firstAt.has(t) || Date.parse(at) < Date.parse(firstAt.get(t)!))) firstAt.set(t, at);
  }
  const fromMs = Date.parse(w.from), toMs = Date.parse(w.to);
  const first = candidates.filter((t) => { const at = Date.parse(firstAt.get(t) ?? ""); return at >= fromMs && at < toMs; });
  if (!first.length) return [];

  // 3. The conversations now: on this client's portals, not in Trash; a deleted one is not billed.
  const threads = (await chunked<Row>(first, 200, (part) => mi.from("threads").select("id, client_id, lead_id, status").in("id", part), "threads"))
    .filter((t) => portals.has(s(t.client_id)) && s(t.status) !== "trash");
  if (!threads.length) return [];

  // 4. Corrected by a person to a 'no' label: not billed.
  const { data: labelRows, error: lErr } = await mi.from("labels").select("id, name");
  if (lErr) throw new Error(`labels: ${lErr.message}`);
  const labelName = new Map(((labelRows ?? []) as Row[]).map((l) => [s(l.id), s(l.name)]));
  const corrected = new Set(
    (await chunked<Row>(threads.map((t) => s(t.id)), 200, (part) => mi.from("label_assignments").select("target_id, label_id").eq("target_type", "thread").in("target_id", part), "label_assignments"))
      .filter((a) => CORRECTION_LABELS.has(labelName.get(s(a.label_id)) ?? ""))
      .map((a) => s(a.target_id)),
  );
  const kept = threads.filter((t) => !corrected.has(s(t.id)));
  if (!kept.length) return [];

  // 5. The agents.
  const leads = new Map<string, Row>();
  for (const l of await chunked<Row>([...new Set(kept.map((t) => s(t.lead_id)).filter(Boolean))], 200, (part) => mi.from("leads").select("id, email, full_name").in("id", part), "leads")) leads.set(s(l.id), l);

  // 6. Agents this client already had before its start date: not billed.
  const known = ctx?.startDate ? await knownBefore([...portals], ctx.startDate) : new Set<string>();

  return kept
    .map((t) => {
      const lead = leads.get(s(t.lead_id));
      const email = leadKey(s(lead?.email));
      return {
        key: email || `thread:${s(t.id)}`,
        name: s(lead?.full_name).trim() || email || "Agent",
        at: new Date(firstAt.get(s(t.id)) ?? w.from).toISOString(),
        source: "interested",
        thread: s(t.id),
      };
    })
    .filter((l) => !known.has(l.key))
    .sort((a, b) => a.at.localeCompare(b.at));
};

/** The agents (keys) Interested or introduced on these portals before `startDate` (Eastern): history, and the portals' introductions. */
async function knownBefore(portals: string[], startDate: string): Promise<Set<string>> {
  const mi = getMasterInboxSupabase();
  const before = easternMidnight(startDate).toISOString();
  // Every page (a database answer stops at 1,000 rows).
  const history = await allPages((from, to) => mi.from("label_history").select("lead_id").in("label_name", [INTERESTED_LABEL, INTRODUCTION_LABEL]).in("client_id", portals).lt("assigned_at", before).order("id", { ascending: true }).range(from, to), "label_history")
    .catch((e: unknown) => { if (e instanceof Error && isMissingHistory(e.message)) throw new LeadSourceUnavailable(HISTORY_MISSING); throw e; });
  const leadIds = [...new Set(history.map((r) => s(r.lead_id)).filter(Boolean))];
  const emails = (await chunked<Row>(leadIds, 200, (part) => mi.from("leads").select("email").in("id", part), "leads")).map((l) => leadKey(s(l.email)));
  const intros = await allPages((from, to) => mi.from("client_pipeline_entries").select("lead_email").in("client_id", portals).lt("introduced_at", before).order("id", { ascending: true }).range(from, to), "client_pipeline_entries");
  return new Set([...emails, ...intros.map((r) => leadKey(s(r.lead_email)))].filter(Boolean));
}
/** The "per call" products: booked calls. */
export const callLeads = labelLeads(CALL_LABEL, "call");

export const LEAD_SOURCES: Record<LeadSource, LeadSourceFn> = {
  handoffs: interestedLeads,
  introductions: introductionLeads,
  calls: callLeads,
};

/** The leads of a client in a period, by its chosen definition (or the default). Before dedupe. */
export function billableLeads(osClientId: string, periodStart: string, periodEnd: string, source: LeadSource = DEFAULT_LEAD_SOURCE, ctx?: { startDate?: string }): Promise<BillableLead[]> {
  return LEAD_SOURCES[source](osClientId, periodStart, periodEnd, ctx);
}
