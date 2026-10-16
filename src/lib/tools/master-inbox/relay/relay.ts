import "server-only";

import { osTable, type OsTable } from "@/lib/clients/os-db";

import { introClientFromRow, INTRO_ROW_COLUMNS } from "../inbox/intro-macro.ts";
import { escapeLike } from "../portals/stop-person-plan.ts";
import { getMasterInboxSupabase, workspaceId } from "../supabase";

import { fromAddress, liveSendAllowed, postmarkToken, sweepSwitchedOff, type Env } from "./gate.ts";
import { agentDisplayName, buildRelayEmail, messageIdFromPayload, replyText, type RelayEmail } from "./message.ts";
import { createPostmarkTransport, fetchBounces, type PostmarkBounce, type Transport } from "./postmark.ts";
import { campaignKey, portalsOfClient, resolveBrokerage, type OsClientRef, type ResolvedBy, type World } from "./resolve.ts";
import {
  agentEmailOf,
  CAP_STATUSES,
  dncHit,
  domainAndParents,
  emailDomain,
  hasIntroductionLabel,
  HOLD_MAX_AGE_MS,
  isActiveStatus,
  isExcludedBrokerage,
  isFromAgent,
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

/** Assignments looked at per sweep — far more than a minute ever produces. */
const BATCH = 200;
/** How far back each sweep looks: enough to cover a restart or a deploy. */
export const SWEEP_WINDOW_MS = 30 * 60 * 1000;
/** Later replies are relayed for this long after the hand-off (when that is switched on). */
const FOLLOW_UP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Held reasons the sweep re-checks by itself. The others wait for the team. */
const RECHECK_REASONS = ["hourly_cap", "no_recipients", "read_error", "evaluating"];
/** Held reasons a team answer for the campaign can clear. */
const CAMPAIGN_REASONS = ["no_campaign", "unknown_campaign", "ambiguous_campaign", "no_roster_record", "campaign_conflict"];
const STALE_EVALUATING_MS = 5 * 60 * 1000;
const BOUNCE_POLL_MS = 10 * 60 * 1000;

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

/** os_clients with every column the relay reads; a column a migration has not added yet reads as empty. */
async function loadClientRows(os: Os): Promise<Row[]> {
  let cols = `id, aliases, status, mi_client_id, ${INTRO_ROW_COLUMNS}, relay_settings, pipeline_entry`;
  for (let i = 0; i <= OPTIONAL_CLIENT_COLUMNS.length; i++) {
    const { data, error } = await os("os_clients").select(cols);
    if (!error) return (data ?? []) as unknown as Row[];
    const missing = OPTIONAL_CLIENT_COLUMNS.find((c) => error.message.includes(c) && cols.includes(c));
    if (!missing) throw new Error(`os_clients: ${error.message}`);
    cols = cols.replace(new RegExp(`,\\s*${missing}\\b`), "");
  }
  throw new Error("os_clients: could not be read");
}

async function optionalRows(os: Os, table: OsTable, columns: string): Promise<Row[]> {
  const { data, error } = await os(table).select(columns);
  if (error) {
    if (missingTable(error.message, table)) return [];
    throw new Error(`${table}: ${error.message}`);
  }
  return (data ?? []) as unknown as Row[];
}

async function loadWorld(mi: Mi, os: Os): Promise<{ world: World; records: Map<string, ClientRecord> }> {
  const [portalsRes, clientRows, routes, team, blocks] = await Promise.all([
    mi.from("clients").select("id, name, slug, aliases"),
    loadClientRows(os),
    optionalRows(os, "os_campaign_portals", "platform, campaign_id, os_client_id, mi_client_id"),
    optionalRows(os, "os_relay_campaigns", "platform, campaign_id, os_client_id, ignored"),
    optionalRows(os, "os_portal_blocks", "os_client_id, mode, lifted_at"),
  ]);
  if (portalsRes.error) throw new Error(`clients: ${portalsRes.error.message}`);
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
    portals: ((portalsRes.data ?? []) as Row[]).map((p) => ({
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

/** The brokerage's DNC entries that could match this agent — by address, company domain, or last name. */
async function dncCandidates(mi: Mi, portals: string[], emails: string[], name: string | null): Promise<DncEntry[]> {
  if (!portals.length) return [];
  const out: DncEntry[] = [];
  const cols = "kind, name, email, domain";
  for (const e of emails) {
    const { data, error } = await mi.from("client_dnc_entries").select(cols).in("client_id", portals).ilike("email", escapeLike(e)).limit(5);
    if (error) throw new Error(`client_dnc_entries: ${error.message}`);
    out.push(...((data ?? []) as unknown as DncEntry[]));
  }
  const domains = [...new Set(emails.flatMap((e) => domainAndParents(emailDomain(e))))];
  if (domains.length) {
    const { data, error } = await mi.from("client_dnc_entries").select(cols).in("client_id", portals).in("domain", domains).limit(5);
    if (error) throw new Error(`client_dnc_entries: ${error.message}`);
    out.push(...((data ?? []) as unknown as DncEntry[]));
  }
  const last = (name ?? "").trim().split(/\s+/).filter((t) => t.length > 1).pop();
  if (last) {
    const { data, error } = await mi.from("client_dnc_entries").select(cols).in("client_id", portals).ilike("name", `%${escapeLike(last)}%`).limit(200);
    if (error) throw new Error(`client_dnc_entries: ${error.message}`);
    out.push(...((data ?? []) as unknown as DncEntry[]));
  }
  return out;
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
  };
}

type Via = { by: "sweep" } | { by: "click"; who: string } | { by: "assign"; who: string };

async function update(ctx: Ctx, id: string, patch: Row): Promise<void> {
  const { error } = await ctx.os("os_brokerage_relays").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
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
    const { data } = await ctx.os("os_brokerage_relays").select("*").eq("id", rec.parentId ?? "").maybeSingle();
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

  const own = replyText(reply);
  if (!own) return stop("skipped", "empty_reply", agent);
  if (looksAutomatic(reply.subject, own, reply.sender)) return stop("skipped", "auto_reply", agent);
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
    const hit = dncHit(await dncCandidates(ctx.mi, portals, agentEmails, facts.lead.fullName ?? reply.senderName), { emails: agentEmails, name: facts.lead.fullName ?? reply.senderName });
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

  let agentMessageId: string | null = null;
  try {
    const { data } = await ctx.mi.from("messages").select("raw_payload").eq("id", reply.id).maybeSingle();
    agentMessageId = messageIdFromPayload((data as Row | null)?.raw_payload);
  } catch {
    /* threading is a nicety; the hand-off does not depend on it */
  }

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

  // One click (the default): prepared and shown; a person presses "Send to brokerage".
  if (effectiveMode(ctx.global, client.relay) === "one_click" && via.by !== "click") {
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
    if (!((claim ?? []) as Row[]).length) return stop("skipped", "already_delivered", computed);
  }

  if (practice) {
    await update(ctx, rec.id, { ...computed, status: "practice", decided_by: decidedBy, decided_at: ctx.now.toISOString() });
    return "practice";
  }

  // LIVE. The transport checks the env switch again before it builds a request.
  await update(ctx, rec.id, { ...computed, status: "sending", decided_by: decidedBy, decided_at: ctx.now.toISOString(), attempts: 1 });
  const res = await ctx.transport.send(email);
  if (res.ok) {
    await update(ctx, rec.id, { status: "sent", sent_at: new Date().toISOString(), provider_message_id: res.messageId });
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
      const { data: rows, error: aErr } = await ctx.mi
        .from("label_assignments")
        .select("target_id, label_id, assigned_at")
        .eq("workspace_id", ctx.ws)
        .eq("target_type", "thread")
        .in("label_id", [...triggerName.keys()])
        .gte("assigned_at", since)
        .order("assigned_at", { ascending: true })
        .limit(BATCH);
      if (aErr) throw new Error(`label_assignments: ${aErr.message}`);
      const first = new Map<string, Row>();
      for (const r of (rows ?? []) as Row[]) if (!first.has(String(r.target_id))) first.set(String(r.target_id), r);
      result.seen = first.size;

      for (const [threadId, a] of first) {
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

    // 2. Held ones the sweep can clear by itself (the hour passed, a contact was added, a read failed).
    const { data: held, error: hErr } = await ctx
      .os("os_brokerage_relays")
      .select("*")
      .eq("workspace_id", ctx.ws)
      .eq("status", "held")
      .in("reason", RECHECK_REASONS)
      .gte("created_at", new Date(now.getTime() - HOLD_MAX_AGE_MS).toISOString())
      .order("created_at", { ascending: true })
      .limit(25);
    if (hErr) throw new Error(`os_brokerage_relays: ${hErr.message}`);
    for (const r of (held ?? []) as Row[]) {
      if (r.reason === "evaluating" && now.getTime() - Date.parse(String(r.updated_at ?? r.created_at)) < STALE_EVALUATING_MS) continue;
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

async function sweepFollowUps(ctx: Ctx, tally: (s: RelayStatus) => void, errors: string[]): Promise<number> {
  const { data: parents, error } = await ctx
    .os("os_brokerage_relays")
    .select("*")
    .eq("workspace_id", ctx.ws)
    .eq("kind", "handoff")
    .in("status", ["sent", "practice"])
    .gte("decided_at", new Date(ctx.now.getTime() - FOLLOW_UP_WINDOW_MS).toISOString())
    .limit(100);
  if (error) throw new Error(`os_brokerage_relays: ${error.message}`);
  let n = 0;
  for (const p of (parents ?? []) as Row[]) {
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
  if (error || !count) return 0;
  const res = await (deps.bounces ?? ((since: Date) => fetchBounces(since, { env: ctx.env })))(weekAgo);
  if (!res.ok) {
    errors.push(`bounces: ${res.error}`);
    return 0;
  }
  let n = 0;
  for (const b of res.bounces) {
    if (!b.MessageID) continue;
    const { data } = await ctx.os("os_brokerage_relays").select("*").eq("provider_message_id", b.MessageID).maybeSingle();
    const rec = data as Row | null;
    if (!rec || rec.status === "bounced") continue;
    const what = `${b.Type}${b.Email ? ` — ${b.Email}` : ""}${b.Description ? `: ${b.Description}` : ""}`.slice(0, 500);
    await update(ctx, String(rec.id), { status: "bounced", bounced_at: b.BouncedAt ?? ctx.now.toISOString(), error: what });
    await ctx.os("os_notifications").upsert(
      {
        kind: "relay_bounce",
        severity: "warning",
        title: `A hand-off to ${str(rec.brokerage_name) ?? "a brokerage"} bounced`,
        body: `${str(rec.agent_name) ?? "An agent"}'s reply did not reach ${b.Email || "the brokerage"} (${b.Type}). Open the conversation: /inbox/all-email/${String(rec.thread_id)}`,
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
 * "Send to brokerage" on a conversation (one-click mode), or "Try again" /
 * "Check again". Re-runs every check first — what was true when the sweep
 * prepared it may not be now.
 */
export async function sendToBrokerage(relayId: string, threadId: string, who: string, deps: RelayDeps = {}, now = new Date()): Promise<RelayRecordView> {
  const { ctx, off } = await makeCtx(now, deps);
  if (!ctx) throw new RelayActionError(`The brokerage hand-off is off (${off}).`, 409);
  const { data, error } = await ctx.os("os_brokerage_relays").select("*").eq("workspace_id", ctx.ws).eq("id", relayId).eq("thread_id", threadId).maybeSingle();
  if (error) throw new RelayActionError(error.message, 502);
  if (!data) throw new RelayActionError("No such hand-off on this conversation.", 404);
  const rec = relayRowFrom(data as Row);
  const allowed = rec.status === "ready" || rec.status === "held" || (rec.status === "failed" && rec.reason === "send_failed");
  if (!allowed) {
    throw new RelayActionError(
      rec.status === "failed"
        ? "Postmark may have sent this one — check Postmark's activity before sending it again."
        : `This hand-off is already ${rec.status}.`,
      409,
    );
  }
  await evaluate(ctx, rec, { by: "click", who });
  const { data: after } = await ctx.os("os_brokerage_relays").select("*").eq("id", relayId).maybeSingle();
  return recordView((after ?? data) as Row);
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
): Promise<{ rechecked: number; outcomes: Partial<Record<RelayStatus, number>> }> {
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
  const { data: held } = await ctx
    .os("os_brokerage_relays")
    .select("*")
    .eq("workspace_id", ctx.ws)
    .eq("status", "held")
    .eq("platform", input.platform)
    .eq("campaign_id", input.campaignId)
    .in("reason", CAMPAIGN_REASONS)
    .limit(100);
  let rechecked = 0;
  for (const r of (held ?? []) as Row[]) {
    rechecked++;
    const s = await evaluate(ctx, relayRowFrom(r), { by: "assign", who });
    outcomes[s] = (outcomes[s] ?? 0) + 1;
  }
  return { rechecked, outcomes };
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
}

/** Everything the Settings tab shows. Reads only; never prints the token, only whether one is set. */
export async function relayOverview(deps: RelayDeps = {}): Promise<RelayOverview> {
  const env = deps.env ?? process.env;
  const os: Os = deps.os ?? osTable;
  const ws = deps.ws ?? (await workspaceId());
  const server = { liveSendAllowed: liveSendAllowed(env), tokenSet: postmarkToken(env) !== null, fromAddress: fromAddress(env) };
  const { settings, missing } = await loadGlobalSettings(os, ws);
  if (missing) return { available: false, settings, server, brokerages: [], held: [], recent: [] };

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

  const { data: heldRows } = await os("os_brokerage_relays")
    .select("*")
    .eq("workspace_id", ws)
    .eq("status", "held")
    .in("reason", CAMPAIGN_REASONS)
    .order("created_at", { ascending: true })
    .limit(500);
  const byCampaign = new Map<string, HeldCampaign>();
  for (const r of (heldRows ?? []) as Row[]) {
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

  const { data: recentRows } = await os("os_brokerage_relays").select("*").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(100);
  return {
    available: true,
    settings,
    server,
    brokerages,
    held: [...byCampaign.values()],
    recent: ((recentRows ?? []) as Row[]).map((r) => ({ ...recordView(r), threadId: String(r.thread_id), agentName: str(r.agent_name) })),
  };
}
