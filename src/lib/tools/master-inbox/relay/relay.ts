import "server-only";

import { osTable, type OsTable } from "@/lib/clients/os-db";

import { introClientFromRow, INTRO_ROW_COLUMNS } from "../inbox/intro-macro.ts";
import { escapeLike } from "../portals/stop-person-plan.ts";
import { getMasterInboxSupabase, workspaceId } from "../supabase";

import { fromAddress, liveSendAllowed, postmarkToken, sweepSwitchedOff, type Env } from "./gate.ts";
import { agentDisplayName, buildRelayEmail, messageIdFromPayload, providerSaysAutomatic, replyText, type RelayEmail } from "./message.ts";
import { bounceKind, createPostmarkTransport, fetchBounces, type PostmarkBounce, type Transport } from "./postmark.ts";
import { campaignKey, portalsOfClient, resolveBrokerage, type OsClientRef, type ResolvedBy, type World } from "./resolve.ts";
import {
  agentEmailOf,
  CAP_STATUSES,
  dncHit,
  hasIntroductionLabel,
  HOLD_MAX_AGE_MS,
  isActiveStatus,
  isExcludedBrokerage,
  isFromAgent,
  isStaleReply,
  isTriggerLabel,
  looksAutomatic,
  looksLikeOptOut,
  normEmail,
  pickAgentReply,
  planRecipients,
  replyToOf,
  stopLabel,
  type DncEntry,
  type LeadFacts,
  type MessageFacts,
  type Recipient,
} from "./rules.ts";
import {
  brokerageFromJson,
  brokerageToJson,
  deliveryMode,
  effectiveCap,
  effectiveMode,
  globalFromRow,
  globalToRow,
  parseBrokeragePatch,
  parseGlobalPatch,
  pipelineEntryFrom,
  RelaySettingsError,
  type BrokerageRelaySettings,
  type GlobalRelaySettings,
  type PipelineEntry,
} from "./settings.ts";
import { recordView, type RelayRecordView, type RelayStatus } from "./wording.ts";

/*
 * Interested replies → the brokerage (plan "Interested replies, straight to
 * the brokerage", approved Oct 2026). The rules are in rules.ts / resolve.ts /
 * message.ts; this file loads, decides in order, records, and — only when
 * every lock is open — hands the message to Postmark.
 *
 * ---------------------------------------------------------------------------
 * WHY A SWEEP, LIKE THE SLACK ALERT
 *
 * Interested is applied in three places across two codebases: by the AI in
 * the standalone inbox (where the EmailBison webhooks land), and by a person
 * in either app. label_assignments is the one table all of them write, so the
 * OS reads it once a minute (instrumentation.ts) and needs no change in either
 * app — exactly as interested-alerts.ts does. "Meetings Booked" counts too.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WRITES — AND WHAT IT NEVER WRITES
 *
 * Only the OS's own new tables, through osTable(): os_brokerage_relays (every
 * hand-off considered, with the message), os_brokerage_relay_agents (the
 * once-per-agent claims), os_relay_campaigns (the team's answers) and
 * os_notifications (a bounce). Master Inbox's tables — threads, labels,
 * client_pipeline_entries, the portals — are only READ: no label is applied,
 * no portal entry is created, nothing reaches Follow Up Boss. Whether a
 * hand-off should count as an introduction, and the client's pipeline-entry
 * setting, are RECORDED on each hand-off for the team to review.
 *
 * ---------------------------------------------------------------------------
 * ONCE, ENFORCED BY THE DATABASE
 *
 *   per conversation   os_brokerage_relays.dedupe_key 'handoff:<thread>' is
 *                      UNIQUE: one sweep claims it, every other finds it taken.
 *   per agent+brokerage os_brokerage_relay_agents' primary key: the first
 *                      delivery (or, in practice, would-be delivery) claims
 *                      it; any later conversation of the same agent with the
 *                      same brokerage is skipped "already_delivered".
 */

type Row = Record<string, unknown>;
type Mi = ReturnType<typeof getMasterInboxSupabase>;
type Os = (table: OsTable) => ReturnType<typeof osTable>;

/** Rows per page when a list is read in full. */
const PAGE = 1000;
/** New hand-offs decided per sweep; the rest wait (unclaimed) for the next minute. ~60 a MONTH is normal. */
const MAX_NEW_PER_SWEEP = 100;
/** How far back each sweep looks: enough to cover a restart or a deploy. */
export const SWEEP_WINDOW_MS = 30 * 60 * 1000;
/** Later replies are relayed for this long after the hand-off (when that is switched on). */
const FOLLOW_UP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Held reasons the sweep re-checks by itself. The others wait for the team. */
const RECHECK_REASONS = ["hourly_cap", "no_recipients", "read_error", "evaluating"];
/** Held reasons a team answer for the campaign can clear. */
const CAMPAIGN_REASONS = ["unknown_campaign", "ambiguous_campaign", "no_roster_record", "campaign_conflict"];
/** A held hand-off is checked again at most this often (and an interrupted "evaluating" one after this long). */
const RECHECK_EVERY_MS = 5 * 60 * 1000;
/** Held hand-offs re-checked per sweep, least recently checked first, so none is starved. */
const RECHECK_PER_SWEEP = 25;
const BOUNCE_POLL_MS = 10 * 60 * 1000;
/** A brokerage's DNC list longer than this is not trusted to have been read in full: held. */
const DNC_MAX_ROWS = 50_000;
/** Held conversations an admin's campaign answer re-checks in the request itself; the rest go to the sweep. */
const ASSIGN_INLINE = 50;

/** Split a list for `in (…)` filters, which travel in the URL. */
function chunks<T>(list: T[], size = 50): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

type PageResult = { data: unknown; error: { message: string } | null; count?: number | null };

/*
 * Every row of a query, page by page — a capped first page is never taken for
 * the whole list. The first page asks for the exact total, so a server whose
 * page limit is smaller than ours is still read to the end; more than `max`
 * rows is an error, never a silent cut. `make(from, to, first)` builds the
 * query for one page (ordered by something stable).
 */
async function readAll(make: (from: number, to: number, first: boolean) => PromiseLike<PageResult>, label: string, max: number): Promise<Row[]> {
  const out: Row[] = [];
  let total: number | null = null;
  for (let from = 0; ; ) {
    const { data, error, count } = await make(from, from + PAGE - 1, from === 0);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = (data ?? []) as Row[];
    if (from === 0 && typeof count === "number") total = count;
    out.push(...rows);
    from += rows.length;
    if (total !== null ? out.length >= total : rows.length < PAGE) return out;
    if (!rows.length) throw new Error(`${label}: ${out.length} of ${total} rows read — the rest did not come`);
    if (out.length >= max) throw new Error(`${label}: more than ${max} rows — not read in full`);
  }
}

export interface RelayDeps {
  mi?: Mi;
  os?: Os;
  ws?: string;
  transport?: Transport;
  env?: Env;
  bounces?: (since: Date) => Promise<{ ok: true; bounces: PostmarkBounce[] } | { ok: false; error: string }>;
}

interface ClientRecord extends OsClientRef {
  status: string | null;
  row: Row;
  relay: BrokerageRelaySettings;
  pipelineEntry: PipelineEntry;
  blocked: boolean;
}

interface Ctx {
  mi: Mi;
  os: Os;
  ws: string;
  transport: Transport;
  env: Env;
  global: GlobalRelaySettings;
  world: World;
  records: Map<string, ClientRecord>;
  now: Date;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const missingTable = (msg: string, table: string) => new RegExp(`${table}|schema cache|does not exist|PGRST205`, "i").test(msg);

/* ------------------------------------------------------------------------ */
/* Loading                                                                   */

export async function loadGlobalSettings(os: Os, ws: string): Promise<{ settings: GlobalRelaySettings; missing: boolean }> {
  const { data, error } = await os("os_relay_settings").select("*").eq("workspace_id", ws).maybeSingle();
  if (error) {
    if (missingTable(error.message, "os_relay_settings")) return { settings: globalFromRow(null), missing: true };
    throw new Error(`os_relay_settings: ${error.message}`);
  }
  return { settings: globalFromRow(data as Row | null), missing: false };
}

const OPTIONAL_CLIENT_COLUMNS = ["intro_override", "more_contacts", "contact_territories", "intro_variants", "relay_settings", "pipeline_entry"];

/** The database's own message, without readAll's "<label>: " prefix (which names the table). */
const dbMessage = (e: unknown, label: string) => (e instanceof Error ? e.message : String(e)).replace(new RegExp(`^${label}: `), "");

/** os_clients with every column the relay reads (every page); a column a migration has not added yet reads as empty. */
async function loadClientRows(os: Os): Promise<Row[]> {
  let cols = `id, aliases, status, mi_client_id, ${INTRO_ROW_COLUMNS}, relay_settings, pipeline_entry`;
  for (let i = 0; i <= OPTIONAL_CLIENT_COLUMNS.length; i++) {
    try {
      const select = cols;
      return await readAll(
        (from, to, first) => os("os_clients").select(select, first ? { count: "exact" } : undefined).order("id", { ascending: true }).range(from, to),
        "os_clients",
        20_000,
      );
    } catch (e) {
      const msg = dbMessage(e, "os_clients");
      const missing = OPTIONAL_CLIENT_COLUMNS.find((c) => msg.includes(c) && cols.includes(c));
      if (!missing) throw new Error(`os_clients: ${msg}`);
      cols = cols.replace(new RegExp(`,\\s*${missing}\\b`), "");
    }
  }
  throw new Error("os_clients: could not be read");
}

/*
 * A table a migration may not have created yet reads as empty; any other
 * failure throws. Every page is read: os_campaign_portals grows with every
 * campaign, and a route missing from a capped page would change which
 * brokerage a conversation resolves to.
 */
async function optionalRows(os: Os, table: OsTable, columns: string, orderBy: string[]): Promise<Row[]> {
  try {
    return await readAll(
      (from, to, first) => {
        let q = os(table).select(columns, first ? { count: "exact" } : undefined);
        for (const c of orderBy) q = q.order(c, { ascending: true });
        return q.range(from, to);
      },
      table,
      50_000,
    );
  } catch (e) {
    const msg = dbMessage(e, table);
    if (missingTable(msg, table)) return [];
    throw new Error(`${table}: ${msg}`);
  }
}

async function loadWorld(mi: Mi, os: Os): Promise<{ world: World; records: Map<string, ClientRecord> }> {
  const [portalRows, clientRows, routes, team, blocks] = await Promise.all([
    readAll(
      (from, to, first) => mi.from("clients").select("id, name, slug, aliases", first ? { count: "exact" } : undefined).order("id", { ascending: true }).range(from, to),
      "clients",
      20_000,
    ),
    loadClientRows(os),
    optionalRows(os, "os_campaign_portals", "platform, campaign_id, os_client_id, mi_client_id", ["platform", "campaign_id"]),
    optionalRows(os, "os_relay_campaigns", "platform, campaign_id, os_client_id, ignored", ["platform", "campaign_id"]),
    optionalRows(os, "os_portal_blocks", "id, os_client_id, mode, lifted_at", ["id"]),
  ]);
  const blocked = new Set(blocks.filter((b) => b.mode === "blocked" && !b.lifted_at).map((b) => String(b.os_client_id)));
  const records = new Map<string, ClientRecord>();
  for (const r of clientRows) {
    const id = String(r.id);
    records.set(id, {
      id,
      name: String(r.name ?? ""),
      aliases: Array.isArray(r.aliases) ? (r.aliases as unknown[]).map(String) : [],
      miClientId: str(r.mi_client_id),
      status: str(r.status),
      row: r,
      relay: brokerageFromJson(r.relay_settings),
      pipelineEntry: pipelineEntryFrom(r.pipeline_entry),
      blocked: blocked.has(id),
    });
  }
  const world: World = {
    portals: portalRows.map((p) => ({
      id: String(p.id),
      name: String(p.name ?? ""),
      slug: str(p.slug),
      aliases: Array.isArray(p.aliases) ? (p.aliases as unknown[]).map(String) : [],
    })),
    clients: [...records.values()].map(({ id, name, aliases, miClientId }) => ({ id, name, aliases, miClientId })),
    campaignPortals: routes.map((r) => ({
      platform: String(r.platform),
      campaignId: String(r.campaign_id),
      osClientId: String(r.os_client_id),
      miClientId: String(r.mi_client_id),
    })),
    teamCampaigns: team.map((t) => ({
      platform: String(t.platform),
      campaignId: String(t.campaign_id),
      osClientId: str(t.os_client_id),
      ignored: t.ignored === true,
    })),
  };
  return { world, records };
}

interface ThreadFacts {
  id: string;
  portalId: string | null;
  platform: string | null;
  campaignId: string | null;
  campaignName: string | null;
  subject: string | null;
  lead: LeadFacts;
  messages: MessageFacts[];
  labels: string[];
}

async function loadThread(mi: Mi, ws: string, threadId: string): Promise<ThreadFacts | null> {
  const { data: t, error } = await mi
    .from("threads")
    .select("id, workspace_id, client_id, lead_id, campaign_id, campaign_name, source_provider, subject")
    .eq("id", threadId)
    .eq("workspace_id", ws)
    .maybeSingle();
  if (error) throw new Error(`threads: ${error.message}`);
  if (!t) return null;
  const thread = t as Row;

  let lead: LeadFacts = { id: null, fullName: null, email: null };
  if (str(thread.lead_id)) {
    const { data, error: lErr } = await mi.from("leads").select("id, full_name, email").eq("id", String(thread.lead_id)).maybeSingle();
    if (lErr) throw new Error(`leads: ${lErr.message}`);
    const l = data as Row | null;
    lead = { id: str(l?.id), fullName: str(l?.full_name), email: str(l?.email) };
  }

  // The newest 200 (a conversation that long still hands over its latest reply), oldest first below.
  const { data: msgs, error: mErr } = await mi
    .from("messages")
    .select("id, direction, sender, sender_name, subject, body_text, body_html, sent_at")
    .eq("thread_id", threadId)
    .order("sent_at", { ascending: false })
    .limit(200);
  if (mErr) throw new Error(`messages: ${mErr.message}`);
  const ordered = ((msgs ?? []) as Row[]).reverse();

  const { data: assigns, error: aErr } = await mi
    .from("label_assignments")
    .select("label_id")
    .eq("target_type", "thread")
    .eq("target_id", threadId);
  if (aErr) throw new Error(`label_assignments: ${aErr.message}`);
  const ids = [...new Set(((assigns ?? []) as Row[]).map((a) => String(a.label_id)))];
  let labels: string[] = [];
  if (ids.length) {
    const { data: named, error: nErr } = await mi.from("labels").select("id, name").in("id", ids);
    if (nErr) throw new Error(`labels: ${nErr.message}`);
    labels = ((named ?? []) as Row[]).map((l) => String(l.name ?? "")).filter(Boolean);
  }

  return {
    id: String(thread.id),
    portalId: str(thread.client_id),
    platform: str(thread.source_provider),
    campaignId: thread.campaign_id == null ? null : str(String(thread.campaign_id)),
    campaignName: str(thread.campaign_name),
    subject: str(thread.subject),
    lead,
    labels,
    messages: ordered.map((m) => ({
      id: String(m.id),
      direction: m.direction === "inbound" ? "inbound" : "outbound",
      sender: str(m.sender),
      senderName: str(m.sender_name),
      subject: str(m.subject),
      bodyText: typeof m.body_text === "string" ? m.body_text : null,
      bodyHtml: typeof m.body_html === "string" ? m.body_html : null,
      sentAt: str(m.sent_at),
    })),
  };
}

/*
 * The brokerage's WHOLE Do Not Contact list, every page. It used to be
 * pre-filtered in the database — by the raw last word of the agent's name
 * (so "Robert Smith Jr." looked for "Jr." and "José Núñez" never found "Jose
 * Nunez") with a 200-row cap, and by an exact domain string (so "www.kw.com"
 * or "@kw.com" never matched "kw.com"). Matching now happens in dncHit with
 * the DNC tool's own rules. The largest list is a few thousand short rows; a
 * list that cannot be read in full throws, and the hand-off is HELD.
 */
async function loadDnc(mi: Mi, portals: string[]): Promise<DncEntry[]> {
  if (!portals.length) return [];
  const rows = await readAll(
    (from, to, first) =>
      mi
        .from("client_dnc_entries")
        .select("id, kind, name, email, domain", first ? { count: "exact" } : undefined)
        .in("client_id", portals)
        .order("id", { ascending: true })
        .range(from, to),
    "client_dnc_entries",
    DNC_MAX_ROWS,
  );
  return rows.map((r) => ({ kind: str(r.kind), name: str(r.name), email: str(r.email), domain: str(r.domain) }));
}

async function anyRow(q: PromiseLike<{ data: unknown; error: { message: string } | null }>, label: string): Promise<boolean> {
  const { data, error } = await q;
  if (error) throw new Error(`${label}: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/* ------------------------------------------------------------------------ */
/* Deciding one hand-off                                                     */

interface RelayRow {
  id: string;
  kind: "handoff" | "follow_up";
  threadId: string;
  messageId: string | null;
  parentId: string | null;
  trigger: string;
  triggeredAt: string | null;
  createdAt: string | null;
  status: RelayStatus;
  reason: string | null;
  decidedBy: string | null;
  attempts: number;
  /** Whether it was prepared (or last decided) in practice — what a person was shown. */
  practice: boolean;
}

function relayRowFrom(r: Row): RelayRow {
  return {
    id: String(r.id),
    kind: r.kind === "follow_up" ? "follow_up" : "handoff",
    threadId: String(r.thread_id),
    messageId: str(r.message_id),
    parentId: str(r.parent_id),
    trigger: String(r.trigger ?? "Interested"),
    triggeredAt: str(r.triggered_at),
    createdAt: str(r.created_at),
    status: (str(r.status) ?? "held") as RelayStatus,
    reason: str(r.reason),
    decidedBy: str(r.decided_by),
    attempts: Number.isFinite(Number(r.attempts)) ? Number(r.attempts) : 0,
    practice: r.practice !== false,
  };
}

/*
 * Who is deciding, and with what intent:
 *   sweep   the minute sweep
 *   check   a person pressed "Check again" on a held one — re-run the checks,
 *           exactly as the sweep would; in one-click mode it is PREPARED,
 *           never sent (the button did not say "Send")
 *   assign  an admin answered a held campaign — the same as a check
 *   click   a person pressed "Send to brokerage" / "Try again" — the only
 *           intent that sends in one-click mode
 */
type Via = { by: "sweep" } | { by: "check"; who: string } | { by: "click"; who: string } | { by: "assign"; who: string };

/** Stamped with the decision's own clock (ctx.now), which the re-check schedule compares against. */
async function update(ctx: Ctx, id: string, patch: Row): Promise<void> {
  const { error } = await ctx.os("os_brokerage_relays").update({ ...patch, updated_at: ctx.now.toISOString() }).eq("id", id);
  if (error) throw new Error(`os_brokerage_relays: ${error.message}`);
}

/**
 * Decides one hand-off and records the decision. Returns the status it ended in.
 * Every early return writes WHY, so the conversation and the log can say so.
 */
async function evaluate(ctx: Ctx, rec: RelayRow, via: Via): Promise<RelayStatus> {
  const decidedBy = via.by === "sweep" ? "sweep" : via.who;
  // What is known so far goes on the record too; the status and the reason always win.
  const stop = async (status: "held" | "skipped", reason: string, extra: Row = {}): Promise<RelayStatus> => {
    await update(ctx, rec.id, { ...extra, status, reason, decided_by: decidedBy, decided_at: ctx.now.toISOString() });
    return status;
  };

  // The kill switch is read for every decision, not once per process.
  if (!ctx.global.enabled) return rec.status;

  if (rec.createdAt && ctx.now.getTime() - Date.parse(rec.createdAt) > HOLD_MAX_AGE_MS) return stop("skipped", "too_old");

  let facts: ThreadFacts | null;
  try {
    facts = await loadThread(ctx.mi, ctx.ws, rec.threadId);
  } catch (e) {
    return stop("held", "read_error", { detail: e instanceof Error ? e.message.slice(0, 300) : String(e) });
  }
  if (!facts) return stop("skipped", "no_agent_reply", { detail: "the conversation is gone" });

  const key = campaignKey(facts);
  const base: Row = {
    platform: key?.platform ?? facts.platform,
    campaign_id: key?.campaignId ?? facts.campaignId,
    campaign_name: facts.campaignName,
    agent_email: agentEmailOf(facts.lead, null),
    agent_name: facts.lead.fullName,
  };

  // The label that started it must still be on (a hand-off; a later reply has no label of its own).
  if (rec.kind === "handoff" && !facts.labels.some(isTriggerLabel)) return stop("skipped", "no_longer_interested", base);
  const stopped = stopLabel(facts.labels);
  if (stopped) return stop("skipped", "stop_label", { ...base, detail: stopped });

  // Which brokerage: from the campaign (a later reply: the hand-off's brokerage).
  let osClientId: string;
  let portalId: string | null;
  let resolvedBy: ResolvedBy | "hand-off";
  let parent: Row | null = null;
  if (rec.kind === "follow_up") {
    if (!rec.parentId) return stop("skipped", "no_agent_reply", { ...base, detail: "the hand-off it follows is gone" });
    const { data, error: pErr } = await ctx.os("os_brokerage_relays").select("*").eq("id", rec.parentId).maybeSingle();
    // A read that failed is not "gone": held, and checked again.
    if (pErr) return stop("held", "read_error", { ...base, detail: `the hand-off it follows: ${pErr.message.slice(0, 200)}` });
    parent = (data as Row | null) ?? null;
    if (!parent || !str(parent.os_client_id)) return stop("skipped", "no_agent_reply", { ...base, detail: "the hand-off it follows is gone" });
    osClientId = String(parent.os_client_id);
    portalId = str(parent.mi_client_id);
    resolvedBy = "hand-off";
  } else {
    const r = resolveBrokerage(
      { platform: facts.platform, campaignId: facts.campaignId, campaignName: facts.campaignName, threadPortalId: facts.portalId },
      ctx.world,
    );
    if (!r.ok) return stop(r.outcome === "hold" ? "held" : "skipped", r.reason, { ...base, detail: r.detail ?? null });
    osClientId = r.osClientId;
    portalId = r.portalId;
    resolvedBy = r.source;
  }

  const client = ctx.records.get(osClientId);
  const portalName = ctx.world.portals.find((p) => p.id === portalId)?.name ?? null;
  const who = { ...base, os_client_id: osClientId, mi_client_id: portalId, brokerage_name: client?.name ?? portalName, resolved_by: resolvedBy };
  if (!client) return stop("held", "no_roster_record", who);
  if (isExcludedBrokerage(client.name, portalName)) return stop("skipped", "excluded", who);
  if (!isActiveStatus(client.status)) return stop("skipped", "brokerage_not_active", { ...who, detail: client.status ?? "no status" });
  if (client.blocked) return stop("skipped", "billing_block", who);

  // The agent's reply, and who the agent is.
  const reply =
    rec.kind === "follow_up"
      ? facts.messages.find((m) => m.id === rec.messageId && isFromAgent(m, facts!.lead)) ?? null
      : pickAgentReply(facts.messages, facts.lead, rec.triggeredAt);
  if (!reply) return stop("skipped", "no_agent_reply", who);
  const agentEmail = agentEmailOf(facts.lead, reply);
  const replyTo = replyToOf(facts.lead, reply);
  if (!agentEmail || !replyTo) return stop("skipped", "no_agent_email", who);
  const agentEmails = [...new Set([agentEmail, normEmail(replyTo)])];
  const agentName = agentDisplayName(facts.lead, reply);
  const agent = { ...who, agent_email: agentEmail, agent_name: agentName, message_id: reply.id };

  // An old conversation labelled again (an AI re-label of the workspace, a tidy-up) is not an agent waiting now.
  if (rec.kind === "handoff" && isStaleReply(reply.sentAt, rec.triggeredAt ?? rec.createdAt ?? ctx.now)) {
    return stop("skipped", "stale_reply", { ...agent, detail: reply.sentAt ? `replied ${reply.sentAt.slice(0, 10)}` : "the reply has no date" });
  }

  // What the provider stored with the reply: EmailBison's own "automatic reply" verdict, and the Message-ID for threading.
  let payload: unknown = null;
  try {
    const { data, error } = await ctx.mi.from("messages").select("raw_payload").eq("id", reply.id).maybeSingle();
    if (!error) payload = (data as Row | null)?.raw_payload ?? null;
  } catch {
    /* both are extras: the text checks below still run, and the headers are simply left out */
  }

  const own = replyText(reply);
  if (!own) return stop("skipped", "empty_reply", agent);
  if (providerSaysAutomatic(payload) || looksAutomatic(reply.subject, own, reply.sender)) return stop("skipped", "auto_reply", agent);
  if (looksLikeOptOut(own)) return stop("skipped", "unsubscribe", agent);

  const portals = [...new Set([...portalsOfClient(osClientId, ctx.world), ...(portalId ? [portalId] : [])])];
  try {
    if (rec.kind === "handoff") {
      if (hasIntroductionLabel(facts.labels)) return stop("skipped", "already_introduced", { ...agent, detail: "Introduction label" });
      for (const e of agentEmails) {
        if (portals.length && (await anyRow(ctx.mi.from("client_pipeline_entries").select("id").in("client_id", portals).ilike("lead_email", escapeLike(e)).limit(1), "client_pipeline_entries"))) {
          return stop("skipped", "already_introduced", { ...agent, detail: "in their pipeline" });
        }
      }
      if (facts.lead.id && portals.length && (await anyRow(ctx.mi.from("client_pipeline_entries").select("id").in("client_id", portals).eq("lead_id", facts.lead.id).limit(1), "client_pipeline_entries"))) {
        return stop("skipped", "already_introduced", { ...agent, detail: "in their pipeline" });
      }
    }
    const dnc = await loadDnc(ctx.mi, portals);
    // Both names: the lead record's and the one the reply was signed with, should they differ.
    const names = [...new Set([facts.lead.fullName, reply.senderName].filter((n): n is string => !!n))];
    const hit = names.length
      ? names.map((name) => dncHit(dnc, { emails: agentEmails, name })).find(Boolean) ?? null
      : dncHit(dnc, { emails: agentEmails, name: null });
    if (hit) return stop("skipped", "dnc", { ...agent, detail: `by ${hit.by}` });
    for (const e of agentEmails) {
      if (portals.length && (await anyRow(ctx.mi.from("client_agents").select("id").in("client_id", portals).ilike("email", escapeLike(e)).limit(1), "client_agents"))) {
        return stop("skipped", "their_agent", agent);
      }
    }
  } catch (e) {
    // An unreadable list is treated as a list with the agent on it: held, never sent.
    return stop("held", "read_error", { ...agent, detail: e instanceof Error ? e.message.slice(0, 300) : String(e) });
  }

  // Who receives it.
  let recipients: Recipient[];
  if (rec.kind === "follow_up") {
    recipients = recordView(parent!).recipients;
  } else {
    recipients = planRecipients(client.relay, introClientFromRow(client.row, client.name), facts.campaignName, agentEmails).recipients;
  }
  if (!recipients.length) return stop("held", "no_recipients", agent);

  // Live only when every lock is open; a later reply never goes live after a practised hand-off.
  const parentPractised = rec.kind === "follow_up" && parent?.practice !== false;
  const mode = parentPractised ? "practice" : deliveryMode(ctx.global, client.relay, liveSendAllowed(ctx.env));
  const practice = mode === "practice";

  const agentMessageId = messageIdFromPayload(payload);

  const email: RelayEmail = buildRelayEmail({
    relayId: rec.id,
    threadId: facts.id,
    fromAddress: fromAddress(ctx.env),
    agentName,
    replyTo,
    recipients,
    threadSubject: facts.subject,
    reply,
    messages: facts.messages,
    agentMessageId,
  });

  const computed: Row = {
    ...agent,
    status: "held",
    reason: null,
    detail: null,
    error: null,
    recipients,
    from_name: email.fromName,
    from_address: email.fromAddress,
    reply_to: email.replyTo,
    subject: email.subject,
    text_body: email.textBody,
    html_body: email.htmlBody,
    headers: email.headers,
    pipeline_action: client.pipelineEntry === "interested" ? "enter_at_interested" : "none",
    counts_as_introduction: ctx.global.countsAsIntroduction,
    practice,
  };

  // The agent's slot with this brokerage, in this mode — whose is it, if anyone's?
  const claimOwner = async (): Promise<string | null | undefined> => {
    const { data, error } = await ctx
      .os("os_brokerage_relay_agents")
      .select("relay_id")
      .eq("workspace_id", ctx.ws)
      .eq("os_client_id", osClientId)
      .eq("agent_email", agentEmail)
      .eq("mode", mode)
      .maybeSingle();
    if (error) throw new Error(`os_brokerage_relay_agents: ${error.message}`);
    return data ? str((data as Row).relay_id) : undefined; // undefined = nobody's
  };

  // One click (the default): prepared and shown; a person presses "Send to brokerage".
  if (effectiveMode(ctx.global, client.relay) === "one_click" && via.by !== "click") {
    // Already handed to this brokerage: say so now rather than offer a button that would refuse.
    if (rec.kind === "handoff") {
      try {
        const owner = await claimOwner();
        if (owner !== undefined && owner !== rec.id) return stop("skipped", "already_delivered", computed);
      } catch (e) {
        return stop("held", "read_error", { ...computed, detail: e instanceof Error ? e.message.slice(0, 300) : String(e) });
      }
    }
    await update(ctx, rec.id, { ...computed, status: "ready", decided_by: decidedBy });
    return "ready";
  }

  /*
   * A press sends only what the person was shown. The button read "Send to
   * brokerage (practice)" if it was prepared in practice; if the locks have
   * opened since (or closed), the press would do something other than what it
   * said — so it is prepared again in the new mode and waits for a new press.
   * The same holds for a press that waited out the hourly cap.
   */
  if (via.by === "click" && rec.practice !== practice) {
    await update(ctx, rec.id, { ...computed, status: "ready", decided_by: decidedBy });
    return "ready";
  }

  // The hourly cap, counted within the same mode (practice counts practice).
  const since = new Date(ctx.now.getTime() - 60 * 60 * 1000).toISOString();
  const { count, error: cErr } = await ctx
    .os("os_brokerage_relays")
    .select("id", { count: "exact", head: true })
    .eq("os_client_id", osClientId)
    .eq("practice", practice)
    .in("status", [...CAP_STATUSES])
    .gte("decided_at", since);
  if (cErr) return stop("held", "read_error", { ...computed, detail: `cap: ${cErr.message}` });
  const cap = effectiveCap(ctx.global, client.relay);
  if ((count ?? 0) >= cap) return stop("held", "hourly_cap", { ...computed, detail: `${cap} an hour` });

  // Never twice: one delivery per agent per brokerage (a later reply continues its hand-off).
  if (rec.kind === "handoff") {
    const { data: claim, error: clErr } = await ctx
      .os("os_brokerage_relay_agents")
      .upsert(
        { workspace_id: ctx.ws, os_client_id: osClientId, agent_email: agentEmail, mode, relay_id: rec.id, claimed_at: ctx.now.toISOString() },
        { onConflict: "workspace_id,os_client_id,agent_email,mode", ignoreDuplicates: true },
      )
      .select("agent_email");
    if (clErr) return stop("held", "read_error", { ...computed, detail: `claim: ${clErr.message}` });
    if (!((claim ?? []) as Row[]).length) {
      // Taken — by another hand-off (skip), or by THIS one in an attempt that stopped before it
      // got as far as "sending" (nothing went; carry on). A record that reached "sending" is
      // never re-evaluated, so this cannot send twice.
      let owner: string | null | undefined;
      try {
        owner = await claimOwner();
      } catch (e) {
        return stop("held", "read_error", { ...computed, detail: e instanceof Error ? e.message.slice(0, 300) : String(e) });
      }
      if (owner !== rec.id) return stop("skipped", "already_delivered", computed);
    }
  }

  if (practice) {
    await update(ctx, rec.id, { ...computed, status: "practice", decided_by: decidedBy, decided_at: ctx.now.toISOString() });
    return "practice";
  }

  /*
   * LIVE. Exactly one process gets past here for this hand-off: the move to
   * "sending" only happens if the record is still in the state and attempt
   * this evaluation read. A double press, two tabs, two people, or a press
   * racing the sweep's re-check all evaluate the same record and all pass the
   * agent-slot claim (it is this record's own) — without this, each would
   * send. The loser stops here, having sent nothing.
   */
  const { data: locked, error: lockErr } = await ctx
    .os("os_brokerage_relays")
    .update({ ...computed, status: "sending", decided_by: decidedBy, decided_at: ctx.now.toISOString(), attempts: rec.attempts + 1, updated_at: ctx.now.toISOString() })
    .eq("id", rec.id)
    .eq("status", rec.status)
    .eq("attempts", rec.attempts)
    .select("id");
  if (lockErr) throw new Error(`os_brokerage_relays: ${lockErr.message}`);
  if (!((locked ?? []) as Row[]).length) return "sending";

  // The transport checks the env switch again before it builds a request.
  const res = await ctx.transport.send(email);
  if (res.ok) {
    try {
      await update(ctx, rec.id, { status: "sent", sent_at: new Date().toISOString(), provider_message_id: res.messageId });
    } catch (e) {
      // It WENT. The record stays "sending", which is never retried; this line is how to repair it.
      console.error(`[brokerage-relay] SENT hand-off ${rec.id} (Postmark MessageID ${res.messageId}) but could not record it: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
    return "sent";
  }
  if (res.definite && rec.kind === "handoff") {
    // Definitely not sent: free the agent's slot so "Try again" can claim it.
    await ctx.os("os_brokerage_relay_agents").delete().eq("workspace_id", ctx.ws).eq("os_client_id", osClientId).eq("agent_email", agentEmail).eq("mode", mode);
  }
  await update(ctx, rec.id, { status: "failed", reason: res.definite ? "send_failed" : "send_unknown", error: res.error.slice(0, 500) });
  return "failed";
}

/* ------------------------------------------------------------------------ */
/* Context                                                                   */

async function makeCtx(now: Date, deps: RelayDeps): Promise<{ ctx: Ctx | null; off: string | null }> {
  const env = deps.env ?? process.env;
  const mi = deps.mi ?? getMasterInboxSupabase();
  const os: Os = deps.os ?? osTable;
  const ws = deps.ws ?? (await workspaceId());
  const { settings, missing } = await loadGlobalSettings(os, ws);
  if (missing) return { ctx: null, off: "migration 0035 has not been run" };
  if (!settings.enabled) return { ctx: null, off: "switched off in Settings" };
  const { world, records } = await loadWorld(mi, os);
  return {
    ctx: { mi, os, ws, env, now, global: settings, world, records, transport: deps.transport ?? createPostmarkTransport({ env }) },
    off: null,
  };
}

/* ------------------------------------------------------------------------ */
/* The sweep                                                                 */

export interface RelaySweepResult {
  seen: number;
  claimed: number;
  outcomes: Partial<Record<RelayStatus, number>>;
  rechecked: number;
  followUps: number;
  bounced: number;
  off: string | null;
  errors: string[];
}

/** The earliest label a sweep looks at: the window, but never before the switch went on. */
export function sweepSince(now: Date, enabledSince: string | null): string | null {
  if (!enabledSince || !Number.isFinite(Date.parse(enabledSince))) return null;
  const windowStart = now.getTime() - SWEEP_WINDOW_MS;
  return new Date(Math.max(windowStart, Date.parse(enabledSince))).toISOString();
}

let lastBouncePoll = 0;

/** One sweep. Never throws. */
export async function sweepBrokerageRelay(now: Date = new Date(), deps: RelayDeps = {}): Promise<RelaySweepResult> {
  const result: RelaySweepResult = { seen: 0, claimed: 0, outcomes: {}, rechecked: 0, followUps: 0, bounced: 0, off: null, errors: [] };
  const tally = (s: RelayStatus) => (result.outcomes[s] = (result.outcomes[s] ?? 0) + 1);
  if (sweepSwitchedOff(deps.env ?? process.env)) return { ...result, off: "OS_BROKERAGE_RELAY=0" };
  try {
    const { ctx, off } = await makeCtx(now, deps);
    if (!ctx) return { ...result, off };
    const since = sweepSince(now, ctx.global.enabledSince);
    if (!since) return { ...result, off: "no go-live time recorded" };

    // 1. New Interested / Meetings Booked labels.
    const { data: labels, error: labErr } = await ctx.mi.from("labels").select("id, name").eq("workspace_id", ctx.ws);
    if (labErr) throw new Error(`labels: ${labErr.message}`);
    const triggerName = new Map(((labels ?? []) as Row[]).filter((l) => isTriggerLabel(str(l.name))).map((l) => [String(l.id), String(l.name)]));
    if (triggerName.size) {
      // Every label in the window, not a first page: a burst must not hide the labels after it.
      const rows = await readAll(
        (from, to, first) =>
          ctx.mi
            .from("label_assignments")
            .select("target_id, label_id, assigned_at", first ? { count: "exact" } : undefined)
            .eq("workspace_id", ctx.ws)
            .eq("target_type", "thread")
            .in("label_id", [...triggerName.keys()])
            .gte("assigned_at", since)
            .order("assigned_at", { ascending: true })
            .order("target_id", { ascending: true })
            .range(from, to),
        "label_assignments",
        20_000,
      );
      const first = new Map<string, Row>();
      for (const r of rows) if (!first.has(String(r.target_id))) first.set(String(r.target_id), r);
      result.seen = first.size;

      // Conversations already recorded are left alone without a write (one read per 50, not an upsert each minute).
      const recorded = new Set<string>();
      for (const ids of chunks([...first.keys()])) {
        const { data: done, error: dErr } = await ctx.os("os_brokerage_relays").select("thread_id").eq("workspace_id", ctx.ws).in("dedupe_key", ids.map((t) => `handoff:${t}`));
        if (dErr) throw new Error(`os_brokerage_relays: ${dErr.message}`);
        for (const d of (done ?? []) as Row[]) recorded.add(String(d.thread_id));
      }
      const fresh = [...first].filter(([threadId]) => !recorded.has(threadId));
      // A burst (an AI re-label, say) is worked through a slice a minute; the rest stay unclaimed until then.
      if (fresh.length > MAX_NEW_PER_SWEEP) result.errors.push(`${fresh.length - MAX_NEW_PER_SWEEP} new label(s) left for the next sweep`);

      for (const [threadId, a] of fresh.slice(0, MAX_NEW_PER_SWEEP)) {
        const { data: claimed, error: cErr } = await ctx
          .os("os_brokerage_relays")
          .upsert(
            {
              workspace_id: ctx.ws,
              dedupe_key: `handoff:${threadId}`,
              kind: "handoff",
              thread_id: threadId,
              trigger: triggerName.get(String(a.label_id)) ?? "Interested",
              triggered_at: str(a.assigned_at),
              status: "held",
              reason: "evaluating",
              practice: true,
              // Explicit, not left to the column default: the send lock compares it.
              attempts: 0,
              decided_by: "sweep",
              created_at: now.toISOString(),
              updated_at: now.toISOString(),
            },
            { onConflict: "dedupe_key", ignoreDuplicates: true },
          )
          .select("*");
        if (cErr) throw new Error(`os_brokerage_relays: ${cErr.message}`);
        const row = ((claimed ?? []) as Row[])[0];
        if (!row) continue; // handed off already, by this or another sweep
        result.claimed++;
        try {
          tally(await evaluate(ctx, relayRowFrom(row), { by: "sweep" }));
        } catch (e) {
          result.errors.push(`${threadId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    /*
     * 2. Held ones the sweep can clear by itself (the hour passed, a contact
     * was added, a read failed, an attempt was interrupted). Each is looked at
     * at most every five minutes, least recently looked at first — every
     * check stamps updated_at — so a pile that stays held (a brokerage with
     * nobody to send to) cannot starve the ones behind it.
     */
    const { data: held, error: hErr } = await ctx
      .os("os_brokerage_relays")
      .select("*")
      .eq("workspace_id", ctx.ws)
      .eq("status", "held")
      .in("reason", RECHECK_REASONS)
      .gte("created_at", new Date(now.getTime() - HOLD_MAX_AGE_MS).toISOString())
      .lt("updated_at", new Date(now.getTime() - RECHECK_EVERY_MS).toISOString())
      .order("updated_at", { ascending: true })
      .limit(RECHECK_PER_SWEEP);
    if (hErr) throw new Error(`os_brokerage_relays: ${hErr.message}`);
    for (const r of (held ?? []) as Row[]) {
      result.rechecked++;
      const row = relayRowFrom(r);
      // Held by the cap after a person pressed Send: it goes when the hour allows, without a second press.
      const clicked = row.reason === "hourly_cap" && row.decidedBy && row.decidedBy !== "sweep" ? row.decidedBy : null;
      try {
        tally(await evaluate(ctx, row, clicked ? { by: "click", who: clicked } : { by: "sweep" }));
      } catch (e) {
        result.errors.push(`${String(r.thread_id)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 3. Later replies (off unless switched on — plan §7, open).
    if (ctx.global.forwardLaterReplies) result.followUps = await sweepFollowUps(ctx, tally, result.errors);

    // 4. Bounces of what was really sent.
    result.bounced = await pollBounces(ctx, deps, result.errors);
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }
  return result;
}

/*
 * Later replies (when switched on). Every hand-off of the last 14 days is
 * read (every page); then ONE query per 50 conversations finds inbound
 * messages newer than what was handed over and not yet relayed, and only
 * those conversations are loaded in full. It used to reload up to 100
 * conversations every minute, and ignore any hand-off past the 100th.
 */
async function sweepFollowUps(ctx: Ctx, tally: (s: RelayStatus) => void, errors: string[]): Promise<number> {
  const windowStart = new Date(ctx.now.getTime() - FOLLOW_UP_WINDOW_MS).toISOString();
  const parents = await readAll(
    (from, to, first) =>
      ctx
        .os("os_brokerage_relays")
        .select("id, thread_id, message_id", first ? { count: "exact" } : undefined)
        .eq("workspace_id", ctx.ws)
        .eq("kind", "handoff")
        .in("status", ["sent", "practice"])
        .gte("decided_at", windowStart)
        .order("id", { ascending: true })
        .range(from, to),
    "os_brokerage_relays",
    20_000,
  );
  if (!parents.length) return 0;

  // Inbound messages of those conversations since the window began, minus the one handed over and anything already relayed.
  const since = new Date(ctx.now.getTime() - FOLLOW_UP_WINDOW_MS - 24 * 60 * 60 * 1000).toISOString();
  const handedIds = new Set(parents.map((p) => str(p.message_id)).filter(Boolean));
  const inbound: Row[] = [];
  for (const ids of chunks([...new Set(parents.map((p) => String(p.thread_id)))])) {
    inbound.push(
      ...(await readAll(
        (from, to, first) =>
          ctx.mi
            .from("messages")
            .select("id, thread_id, sent_at", first ? { count: "exact" } : undefined)
            .in("thread_id", ids)
            .eq("direction", "inbound")
            .gte("sent_at", since)
            .order("id", { ascending: true })
            .range(from, to),
        "messages",
        20_000,
      )),
    );
  }
  const handedAt = new Map(inbound.filter((m) => handedIds.has(String(m.id))).map((m) => [String(m.id), String(m.sent_at)]));
  const candidates = inbound.filter((m) => !handedIds.has(String(m.id)));
  const relayed = new Set<string>();
  for (const ids of chunks(candidates.map((m) => `follow_up:${String(m.id)}`))) {
    const { data, error: fErr } = await ctx.os("os_brokerage_relays").select("message_id").eq("workspace_id", ctx.ws).in("dedupe_key", ids);
    if (fErr) throw new Error(`os_brokerage_relays: ${fErr.message}`);
    for (const r of (data ?? []) as Row[]) relayed.add(String(r.message_id));
  }
  const busy = new Set<string>();
  for (const p of parents) {
    const at = handedAt.get(String(p.message_id));
    const newer = candidates.some((m) => String(m.thread_id) === String(p.thread_id) && !relayed.has(String(m.id)) && (!at || String(m.sent_at) > at));
    if (newer) busy.add(String(p.id));
  }

  let n = 0;
  for (const p of parents.filter((x) => busy.has(String(x.id)))) {
    const facts = await loadThread(ctx.mi, ctx.ws, String(p.thread_id));
    if (!facts) continue;
    const handed = facts.messages.find((m) => m.id === str(p.message_id));
    if (!handed?.sentAt) continue;
    const later = facts.messages.filter((m) => isFromAgent(m, facts.lead) && m.sentAt && m.sentAt > handed.sentAt!);
    for (const m of later) {
      const { data: claimed, error: cErr } = await ctx
        .os("os_brokerage_relays")
        .upsert(
          {
            workspace_id: ctx.ws,
            dedupe_key: `follow_up:${m.id}`,
            kind: "follow_up",
            thread_id: facts.id,
            message_id: m.id,
            parent_id: String(p.id),
            trigger: "later reply",
            triggered_at: m.sentAt,
            status: "held",
            reason: "evaluating",
            practice: true,
            attempts: 0,
            decided_by: "sweep",
            created_at: ctx.now.toISOString(),
            updated_at: ctx.now.toISOString(),
          },
          { onConflict: "dedupe_key", ignoreDuplicates: true },
        )
        .select("*");
      if (cErr) throw new Error(`os_brokerage_relays: ${cErr.message}`);
      const row = ((claimed ?? []) as Row[])[0];
      if (!row) continue;
      n++;
      try {
        tally(await evaluate(ctx, relayRowFrom(row), { by: "sweep" }));
      } catch (e) {
        errors.push(`${facts.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return n;
}

/*
 * Bounces (plan §4, "an alert if any email bounces"): every ten minutes, only
 * when something was really sent in the last week, read Postmark's bounces
 * and mark the hand-off; the OS bell (os_notifications) carries the alert.
 */
async function pollBounces(ctx: Ctx, deps: RelayDeps, errors: string[]): Promise<number> {
  if (ctx.now.getTime() - lastBouncePoll < BOUNCE_POLL_MS && !deps.bounces) return 0;
  lastBouncePoll = ctx.now.getTime();
  const weekAgo = new Date(ctx.now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const { count, error } = await ctx
    .os("os_brokerage_relays")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", ctx.ws)
    .in("status", ["sent", "bounced"])
    .eq("practice", false)
    .gte("sent_at", weekAgo.toISOString());
  if (error) {
    errors.push(`bounces: ${error.message}`);
    return 0;
  }
  if (!count) return 0;
  const res = await (deps.bounces ?? ((since: Date) => fetchBounces(since, { env: ctx.env })))(weekAgo);
  if (!res.ok) {
    errors.push(`bounces: ${res.error}`);
    return 0;
  }
  // Only real failures and spam reports; an out-of-office or a delay means it arrived.
  const failures = res.bounces.filter((b) => b.MessageID && bounceKind(b.Type) !== "ignore");
  const records = new Map<string, Row>();
  for (const ids of chunks([...new Set(failures.map((b) => b.MessageID))])) {
    const { data, error: rErr } = await ctx.os("os_brokerage_relays").select("*").eq("workspace_id", ctx.ws).in("provider_message_id", ids);
    if (rErr) {
      errors.push(`bounces: ${rErr.message}`);
      return 0;
    }
    for (const r of (data ?? []) as Row[]) records.set(String(r.provider_message_id), r);
  }
  let n = 0;
  for (const b of failures) {
    const rec = records.get(b.MessageID);
    if (!rec) continue;
    // A hand-off can go to several people: each address that failed is recorded (and rung) once.
    const seen = String(rec.error ?? "").toLowerCase();
    if (rec.status === "bounced" && (!b.Email || seen.includes(b.Email.toLowerCase()))) continue;
    const spam = bounceKind(b.Type) === "spam";
    const what = `${b.Type}${b.Email ? ` — ${b.Email}` : ""}${b.Description ? `: ${b.Description}` : ""}`.slice(0, 500);
    const error = rec.status === "bounced" && rec.error ? `${String(rec.error)}; ${what}`.slice(0, 1000) : what;
    await update(ctx, String(rec.id), { status: "bounced", bounced_at: str(rec.bounced_at) ?? b.BouncedAt ?? ctx.now.toISOString(), error });
    rec.status = "bounced";
    rec.error = error;
    rec.bounced_at = str(rec.bounced_at) ?? b.BouncedAt ?? ctx.now.toISOString();
    const brokerage = str(rec.brokerage_name) ?? "a brokerage";
    await ctx.os("os_notifications").upsert(
      {
        kind: "relay_bounce",
        severity: "warning",
        title: spam ? `A hand-off to ${brokerage} was reported as spam` : `A hand-off to ${brokerage} bounced`,
        body: spam
          ? `${b.Email || "Someone at the brokerage"} reported ${str(rec.agent_name) ?? "an agent"}'s hand-off as spam (${b.Type}). Postmark will not send to that address again. Open the conversation: /inbox/all-email/${String(rec.thread_id)}`
          : `${str(rec.agent_name) ?? "An agent"}'s reply did not reach ${b.Email || "the brokerage"} (${b.Type}). Open the conversation: /inbox/all-email/${String(rec.thread_id)}`,
        os_client_id: str(rec.os_client_id),
        ref: `relay_bounce:${b.ID}`,
      },
      { onConflict: "ref", ignoreDuplicates: true },
    );
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------------ */
/* A person's actions                                                        */

export class RelayActionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * The one button on a conversation. What it does follows what it SAID, which
 * follows the record's state (brokerage-relay-strip.tsx):
 *
 *   ready              "Send to brokerage"  → send (every check re-run first)
 *   failed/send_failed "Try again"          → send again (Postmark refused it outright)
 *   held               "Check again"        → re-run the checks as the sweep
 *                                              would: in one-click mode that
 *                                              PREPARES it; it never sends
 *
 * A press never sends in a mode the person was not shown: a hand-off
 * prepared in practice that would now go live is prepared again, and `notice`
 * says so (relay.ts evaluate).
 */
export async function sendToBrokerage(
  relayId: string,
  threadId: string,
  who: string,
  deps: RelayDeps = {},
  now = new Date(),
): Promise<RelayRecordView & { notice: string | null }> {
  const { ctx, off } = await makeCtx(now, deps);
  if (!ctx) throw new RelayActionError(`The brokerage hand-off is off (${off}).`, 409);
  const { data, error } = await ctx.os("os_brokerage_relays").select("*").eq("workspace_id", ctx.ws).eq("id", relayId).eq("thread_id", threadId).maybeSingle();
  if (error) throw new RelayActionError(error.message, 502);
  if (!data) throw new RelayActionError("No such hand-off on this conversation.", 404);
  const rec = relayRowFrom(data as Row);
  const send = rec.status === "ready" || (rec.status === "failed" && rec.reason === "send_failed");
  if (!send && rec.status !== "held") {
    throw new RelayActionError(
      rec.status === "failed"
        ? "Postmark may have sent this one — check Postmark's activity before sending it again."
        : `This hand-off is already ${rec.status}.`,
      409,
    );
  }
  await evaluate(ctx, rec, send ? { by: "click", who } : { by: "check", who });
  const { data: after } = await ctx.os("os_brokerage_relays").select("*").eq("id", relayId).maybeSingle();
  const view = recordView((after ?? data) as Row);
  let notice: string | null = null;
  if (send && view.status === "ready") {
    notice = view.practice
      ? "Sending is back in practice since this was prepared — it has been prepared again. Press again to record it as practice."
      : "This was prepared in practice, and sending is now live — nothing was sent. Press Send to brokerage again to send it for real.";
  } else if (view.status === "sending" && rec.status !== "sending") {
    notice = "Someone else is sending this hand-off right now.";
  }
  return { ...view, notice };
}

/**
 * The team's answer for a held campaign: which brokerage it belongs to, or
 * "not a brokerage campaign". Saved for the campaign (so its next replies
 * place themselves), then the conversations held on it are checked again.
 */
export async function assignCampaign(
  input: { platform: string; campaignId: string; campaignName: string | null; osClientId: string | null; ignore: boolean },
  who: string,
  deps: RelayDeps = {},
  now = new Date(),
): Promise<{ rechecked: number; outcomes: Partial<Record<RelayStatus, number>>; queued?: number }> {
  if (!input.platform || !input.campaignId) throw new RelayActionError("platform and campaignId are required.");
  if (!input.ignore && !input.osClientId) throw new RelayActionError("Choose a brokerage, or mark the campaign as not a brokerage campaign.");
  const os: Os = deps.os ?? osTable;
  if (!input.ignore) {
    const { data } = await os("os_clients").select("id").eq("id", input.osClientId!).maybeSingle();
    if (!data) throw new RelayActionError("No such client.", 404);
  }
  const { error } = await os("os_relay_campaigns").upsert(
    {
      platform: input.platform,
      campaign_id: input.campaignId,
      campaign_name: input.campaignName,
      os_client_id: input.ignore ? null : input.osClientId,
      ignored: input.ignore,
      decided_by: who,
      decided_at: now.toISOString(),
    },
    { onConflict: "platform,campaign_id" },
  );
  if (error) throw new RelayActionError(error.message, 502);

  const { ctx } = await makeCtx(now, { ...deps, os });
  const outcomes: Partial<Record<RelayStatus, number>> = {};
  if (!ctx) return { rechecked: 0, outcomes };
  let held: Row[];
  try {
    held = await readAll(
      (from, to, first) =>
        ctx
          .os("os_brokerage_relays")
          .select("*", first ? { count: "exact" } : undefined)
          .eq("workspace_id", ctx.ws)
          .eq("status", "held")
          .eq("platform", input.platform)
          .eq("campaign_id", input.campaignId)
          .in("reason", CAMPAIGN_REASONS)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      "os_brokerage_relays",
      20_000,
    );
  } catch (e) {
    throw new RelayActionError(`Saved, but the conversations held on it could not be read: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
  // Checked now, up to a request's worth; the rest are handed to the sweep (it re-checks "evaluating").
  const now50 = held.slice(0, ASSIGN_INLINE);
  for (const ids of chunks(held.slice(ASSIGN_INLINE).map((r) => String(r.id)))) {
    const { error: qErr } = await ctx.os("os_brokerage_relays").update({ reason: "evaluating", updated_at: new Date(0).toISOString() }).in("id", ids).eq("status", "held");
    if (qErr) throw new RelayActionError(`Saved, but could not queue the rest: ${qErr.message}`, 502);
  }
  let rechecked = 0;
  for (const r of now50) {
    rechecked++;
    const s = await evaluate(ctx, relayRowFrom(r), { by: "assign", who });
    outcomes[s] = (outcomes[s] ?? 0) + 1;
  }
  return { rechecked, outcomes, queued: Math.max(0, held.length - ASSIGN_INLINE) };
}

/** The global switches (admins). Switching on records when, so nothing labelled earlier is relayed. */
export async function saveGlobalSettings(body: unknown, who: string, deps: RelayDeps = {}, now = new Date()): Promise<GlobalRelaySettings> {
  const os: Os = deps.os ?? osTable;
  const ws = deps.ws ?? (await workspaceId());
  const { settings, missing } = await loadGlobalSettings(os, ws);
  if (missing) throw new RelayActionError("Run migration 0035 first — the relay's tables are not there yet.", 409);
  let patch;
  try {
    patch = parseGlobalPatch(body);
  } catch (e) {
    throw new RelayActionError(e instanceof RelaySettingsError ? e.message : "Invalid settings.");
  }
  const row = globalToRow(ws, settings, patch, who, now);
  const { error } = await os("os_relay_settings").upsert(row, { onConflict: "workspace_id" });
  if (error) throw new RelayActionError(error.message, 502);
  return globalFromRow(row);
}

/** One brokerage's switch, recipients, cap, mode and pipeline entry (admins). Writes os_clients only. */
export async function saveBrokerageSettings(osClientId: string, body: unknown, deps: RelayDeps = {}): Promise<{ relay: BrokerageRelaySettings; pipelineEntry: PipelineEntry }> {
  const os: Os = deps.os ?? osTable;
  const read = await os("os_clients").select("id, name, relay_settings").eq("id", osClientId).maybeSingle();
  if (read.error) {
    if (read.error.message.includes("relay_settings")) throw new RelayActionError("Run migration 0035 first.", 409);
    throw new RelayActionError(read.error.message, 502);
  }
  if (!read.data) throw new RelayActionError("No such client.", 404);
  let parsed;
  try {
    parsed = parseBrokeragePatch(body, brokerageFromJson((read.data as Row).relay_settings));
  } catch (e) {
    throw new RelayActionError(e instanceof RelaySettingsError ? e.message : "Invalid settings.");
  }
  const patch: Row = { relay_settings: brokerageToJson(parsed.settings) };
  if (parsed.pipelineEntry) patch.pipeline_entry = parsed.pipelineEntry;
  const { error } = await os("os_clients").update(patch).eq("id", osClientId);
  if (error) {
    if (error.message.includes("pipeline_entry")) throw new RelayActionError("Run migration 0036 first — the pipeline-entry setting is not there yet.", 409);
    throw new RelayActionError(error.message, 502);
  }
  let pipelineEntry: PipelineEntry = parsed.pipelineEntry ?? "introduction";
  if (!parsed.pipelineEntry) {
    const { data } = await os("os_clients").select("pipeline_entry").eq("id", osClientId).maybeSingle();
    pipelineEntry = pipelineEntryFrom((data as Row | null)?.pipeline_entry);
  }
  return { relay: parsed.settings, pipelineEntry };
}

/* ------------------------------------------------------------------------ */
/* What the screens read                                                     */

/** Every hand-off on one conversation, newest first. Reads only. */
export async function threadRelays(threadId: string, deps: RelayDeps = {}): Promise<{ available: boolean; records: RelayRecordView[] }> {
  const os: Os = deps.os ?? osTable;
  const ws = deps.ws ?? (await workspaceId());
  const { data, error } = await os("os_brokerage_relays").select("*").eq("workspace_id", ws).eq("thread_id", threadId).order("created_at", { ascending: false }).limit(20);
  if (error) {
    if (missingTable(error.message, "os_brokerage_relays")) return { available: false, records: [] };
    throw new Error(error.message);
  }
  return { available: true, records: ((data ?? []) as Row[]).map(recordView) };
}

export interface BrokerageRow {
  id: string;
  name: string;
  status: string | null;
  relay: BrokerageRelaySettings;
  pipelineEntry: PipelineEntry;
  contacts: number;
  contactsWithEmail: number;
}

export interface HeldCampaign {
  platform: string;
  campaignId: string;
  campaignName: string | null;
  reason: string;
  detail: string | null;
  conversations: number;
  oldest: string | null;
  threadIds: string[];
}

export interface RelayOverview {
  available: boolean;
  settings: GlobalRelaySettings;
  server: { liveSendAllowed: boolean; tokenSet: boolean; fromAddress: string };
  brokerages: BrokerageRow[];
  held: HeldCampaign[];
  recent: Array<RelayRecordView & { threadId: string; agentName: string | null }>;
  /** The server's time when this was read — the screen dates its lines against it, never against the browser's clock. */
  now: string;
}

/** Everything the Settings tab shows. Reads only; never prints the token, only whether one is set. */
export async function relayOverview(deps: RelayDeps = {}, at = new Date()): Promise<RelayOverview> {
  const env = deps.env ?? process.env;
  const os: Os = deps.os ?? osTable;
  const ws = deps.ws ?? (await workspaceId());
  const now = at.toISOString();
  const server = { liveSendAllowed: liveSendAllowed(env), tokenSet: postmarkToken(env) !== null, fromAddress: fromAddress(env) };
  const { settings, missing } = await loadGlobalSettings(os, ws);
  if (missing) return { available: false, settings, server, brokerages: [], held: [], recent: [], now };

  const rows = await loadClientRows(os);
  const brokerages: BrokerageRow[] = rows
    .map((r) => {
      const intro = introClientFromRow(r, String(r.name ?? ""));
      const people = [
        { name: intro.contactName, role: intro.contactRole, email: intro.contactEmail },
        ...(intro.extraContacts ?? []),
      ].filter((c) => (c.name ?? "").trim() && (c.role ?? "").trim());
      return {
        id: String(r.id),
        name: String(r.name ?? ""),
        status: str(r.status),
        relay: brokerageFromJson(r.relay_settings),
        pipelineEntry: pipelineEntryFrom(r.pipeline_entry),
        contacts: people.length,
        contactsWithEmail: people.filter((c) => (c.email ?? "").includes("@")).length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Every held conversation, so the counts per campaign are the real ones.
  const heldRows = await readAll(
    (from, to, first) =>
      os("os_brokerage_relays")
        .select("id, platform, campaign_id, campaign_name, reason, detail, created_at, thread_id", first ? { count: "exact" } : undefined)
        .eq("workspace_id", ws)
        .eq("status", "held")
        .in("reason", CAMPAIGN_REASONS)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    "os_brokerage_relays",
    20_000,
  );
  const byCampaign = new Map<string, HeldCampaign>();
  for (const r of heldRows) {
    const k = `${str(r.platform) ?? "unknown"}|${str(r.campaign_id) ?? ""}`;
    const g = byCampaign.get(k) ?? {
      platform: str(r.platform) ?? "unknown",
      campaignId: str(r.campaign_id) ?? "",
      campaignName: str(r.campaign_name),
      reason: String(r.reason),
      detail: str(r.detail),
      conversations: 0,
      oldest: str(r.created_at),
      threadIds: [],
    };
    g.conversations++;
    g.threadIds.push(String(r.thread_id));
    byCampaign.set(k, g);
  }

  // The newest 100 — a log, labelled "Recent" on the screen, not a count of anything.
  const { data: recentRows, error: recentErr } = await os("os_brokerage_relays").select("*").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(100);
  if (recentErr) throw new Error(`os_brokerage_relays: ${recentErr.message}`);
  return {
    available: true,
    settings,
    server,
    brokerages,
    held: [...byCampaign.values()],
    recent: ((recentRows ?? []) as Row[]).map((r) => ({ ...recordView(r), threadId: String(r.thread_id), agentName: str(r.agent_name) })),
    now,
  };
}
