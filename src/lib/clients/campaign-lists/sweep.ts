import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { listOsClients } from "@/lib/clients/os-clients";
import { campaignsOfClient, type CampaignRow } from "@/lib/clients/pause-campaigns";
import { DEMO_PORTAL_ID } from "@/lib/crm-preview/demo";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { removeLeads, type MembershipResult } from "@/lib/tools/analytics/campaigns/lead-membership";
import { analyticsTeamId } from "@/lib/tools/analytics/supabase";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

import {
  campaignMode,
  compareEntries,
  entryTarget,
  liveAllowed,
  liveOnlyCampaigns,
  overallStatus,
  planRemovals,
  portalOwners,
  PRACTICE_TEXT,
  SKIP_TEXT,
  sweepSwitchedOff,
  type BisonLead,
  type CampaignOutcome,
  type ClientCampaign,
  type Env,
  type ListEntry,
  type ListSource,
  type PlannedRemoval,
  type RemovalStatus,
} from "./rules";

/*
 * The sweep: new My Agents and DNC entries → off the client's own EmailBison
 * campaigns. The rules (and why it is shaped this way) are in rules.ts.
 *
 * Every pass, in order of when the entries were added:
 *   1. claim the entry (a UNIQUE row in os_campaign_removals — a second
 *      process running the same pass is refused by the database);
 *   2. find its client and the client's campaigns, look the address up in
 *      EmailBison (ONE call: the lead comes back with every campaign it is on);
 *   3. practise, or remove — campaign by campaign (rules.campaignMode);
 *   4. record what happened, and move the cursor past it.
 *
 * It only ever READS the portal lists (client_agents, client_dnc_entries).
 */

type Os = typeof osTable;
type Row = Record<string, unknown>;

export interface SweepDeps {
  os?: Os;
  env?: Env;
  now?: () => Date;
  readEntries?: (source: ListSource, cursor: Cursor, limit: number, before: string) => Promise<ListEntry[]>;
  clients?: () => Promise<OwnerClient[]>;
  portals?: () => Promise<{ id: string; name: string; slug: string | null }[]>;
  campaigns?: (client: OwnerClient) => Promise<ClientCampaign[]>;
  findLeads?: (email: string) => Promise<BisonLead[]>;
  remove?: (campaignId: number, leadIds: number[], actor: string) => Promise<MembershipResult>;
}

export interface OwnerClient {
  id: string;
  name: string;
  aliases: string[];
  miClientId: string | null;
}

export interface Cursor {
  at: string;
  id: string | null;
}

export interface ListSettings {
  /** False before migration 0042 has run. */
  available: boolean;
  enabled: boolean;
  practiceMode: boolean;
  cursor: Cursor | null;
  perRun: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

const MIGRATION = "Run migrations/0042_campaign_lists.sql in the Master Inbox database first — the clean-up's tables are not there yet.";

export class CampaignListError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CampaignListError";
    this.status = status;
  }
}

const OFF: ListSettings = { available: true, enabled: false, practiceMode: true, cursor: null, perRun: 40, updatedAt: null, updatedBy: null };

export async function loadSettings(os: Os = osTable): Promise<ListSettings> {
  const { data, error } = await os("os_campaign_list_settings").select("*").eq("id", "default").maybeSingle();
  if (error) return { ...OFF, available: false };
  const r = (data ?? null) as Row | null;
  if (!r) return OFF;
  return {
    available: true,
    enabled: r.enabled === true,
    practiceMode: r.practice_mode !== false,
    cursor: typeof r.cursor_at === "string" ? { at: r.cursor_at, id: typeof r.cursor_id === "string" ? r.cursor_id : null } : null,
    perRun: Number(r.per_run) || 40,
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
    updatedBy: typeof r.updated_by === "string" ? r.updated_by : null,
  };
}

/**
 * The global switches: { enabled?, practiceMode?, ifUpdatedAt? }. Switching
 * on, or leaving practice, starts from NOW — nothing added earlier is acted
 * on. Switching on ALWAYS starts in practice: leaving practice is its own,
 * later save. Any change to the switches abandons entries a pass had claimed
 * but not finished — they are never finished later under different switches.
 * A page opened before someone else's change cannot undo it.
 */
export async function saveSettings(body: unknown, who: string, os: Os = osTable, now = new Date()): Promise<ListSettings> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const s = await loadSettings(os);
  if (!s.available) throw new CampaignListError(MIGRATION, 409);
  for (const k of ["enabled", "practiceMode"] as const) {
    if (k in b && typeof b[k] !== "boolean") throw new CampaignListError(`${k} must be true or false.`);
  }
  if ("ifUpdatedAt" in b && (b.ifUpdatedAt ?? null) !== s.updatedAt) {
    throw new CampaignListError("These settings were changed by someone else since this page was opened — nothing was saved. The page now shows the newest; make your change again.", 409);
  }
  const enabled = typeof b.enabled === "boolean" ? b.enabled : s.enabled;
  const switchingOn = enabled && !s.enabled;
  const practiceMode = switchingOn ? true : typeof b.practiceMode === "boolean" ? b.practiceMode : s.practiceMode;
  const restart = switchingOn || (enabled && s.practiceMode && !practiceMode);
  const row: Row = {
    id: "default",
    enabled,
    practice_mode: practiceMode,
    updated_at: now.toISOString(),
    updated_by: who,
    ...(restart || !s.cursor ? { cursor_at: now.toISOString(), cursor_id: null } : {}),
  };
  const { error } = await os("os_campaign_list_settings").upsert(row, { onConflict: "id" });
  if (error) throw new CampaignListError(error.message, 502);
  if (enabled !== s.enabled || practiceMode !== s.practiceMode) {
    // Belt and braces: the retry also refuses a claim made under other switches (settings_version).
    const abandoned = await os("os_campaign_removals")
      .update({ status: "skipped", reason: "The clean-up's switches changed before this entry was finished — it was not acted on.", updated_at: now.toISOString() })
      .eq("status", "pending");
    if (abandoned.error) console.error(`[campaign-cleanup] could not mark unfinished entries skipped: ${abandoned.error.message}`);
  }
  return loadSettings(os);
}

export interface ClientListSettings {
  removeEnabled: boolean;
  prospectsCampaignId: string | null;
  prospectsCampaignName: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

const CLIENT_OFF: ClientListSettings = { removeEnabled: false, prospectsCampaignId: null, prospectsCampaignName: null, updatedAt: null, updatedBy: null };

function clientFromRow(r: Row | null): ClientListSettings {
  if (!r) return CLIENT_OFF;
  return {
    removeEnabled: r.remove_enabled === true,
    prospectsCampaignId: typeof r.prospects_campaign_id === "string" ? r.prospects_campaign_id : null,
    prospectsCampaignName: typeof r.prospects_campaign_name === "string" ? r.prospects_campaign_name : null,
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
    updatedBy: typeof r.updated_by === "string" ? r.updated_by : null,
  };
}

/** One client's switch, read now — never a copy from the start of a pass. Unreadable = off. */
async function clientSwitchOn(os: Os, osClientId: string): Promise<boolean> {
  const { data, error } = await os("os_campaign_list_clients").select("remove_enabled").eq("os_client_id", osClientId).maybeSingle();
  return !error && (data as Row | null)?.remove_enabled === true;
}

async function clientSwitches(os: Os): Promise<Map<string, ClientListSettings>> {
  const { data, error } = await os("os_campaign_list_clients").select("*");
  if (error) return new Map();
  return new Map(((data ?? []) as Row[]).map((r) => [String(r.os_client_id), clientFromRow(r)]));
}

/* ------------------------------------------------------------------------- */

const ENTRY_COLUMNS: Record<ListSource, string> = {
  my_agents: "id, client_id, email, name, created_at",
  dnc: "id, client_id, email, name, kind, created_at",
};
const TABLE: Record<ListSource, string> = { my_agents: "client_agents", dnc: "client_dnc_entries" };

/**
 * Entries added after the cursor and before `before`, oldest first. Read-only.
 * `before` holds back the last two minutes: created_at is when an insert
 * BEGAN, so a long CSV import can commit after a later single add — reading
 * right up to now could move the cursor past rows not yet visible.
 */
async function readEntriesFromMi(source: ListSource, cursor: Cursor, limit: number, before: string): Promise<ListEntry[]> {
  let q = getMasterInboxSupabase().from(TABLE[source]).select(ENTRY_COLUMNS[source]).lt("created_at", before);
  q = cursor.id
    ? q.or(`created_at.gt."${cursor.at}",and(created_at.eq."${cursor.at}",id.gt.${cursor.id})`)
    : q.gte("created_at", cursor.at);
  const { data, error } = await q.order("created_at", { ascending: true }).order("id", { ascending: true }).limit(limit);
  if (error) throw new Error(`${TABLE[source]}: ${error.message}`);
  return (data ?? []) as unknown as ListEntry[];
}

/*
 * The OS's own client rows — the same names and aliases the master list
 * reads (listOsClients), without the 15-second master list itself.
 */
async function ownerClients(): Promise<OwnerClient[]> {
  return (await listOsClients()).map((c) => ({ id: c.id, name: c.name, aliases: c.aliases ?? [], miClientId: c.links.masterInbox ?? null }));
}

async function portalRows(): Promise<{ id: string; name: string; slug: string | null }[]> {
  const { data, error } = await getMasterInboxSupabase().from("clients").select("id, name, slug");
  if (error) throw new Error(`Master Inbox portals: ${error.message}`);
  return (data ?? []) as { id: string; name: string; slug: string | null }[];
}

/** EmailBison only — every Instantly campaign is archived (rules.ts). */
async function bisonCampaigns(client: OwnerClient): Promise<ClientCampaign[]> {
  const rows: CampaignRow[] = await campaignsOfClient(client);
  return rows.filter((r) => r.platform === "emailbison").map((r) => ({ id: r.id, name: r.name, status: r.status }));
}

function realDeps(d: SweepDeps) {
  return {
    os: d.os ?? osTable,
    env: d.env ?? process.env,
    now: d.now ?? (() => new Date()),
    readEntries: d.readEntries ?? readEntriesFromMi,
    clients: d.clients ?? ownerClients,
    portals: d.portals ?? portalRows,
    campaigns: d.campaigns ?? bisonCampaigns,
    findLeads: d.findLeads ?? ((email: string) => createEmailBisonClient().findLeadsByEmail(email)),
    remove: d.remove ?? ((campaignId: number, leadIds: number[], actor: string) => removeLeads(campaignId, leadIds, actor, analyticsTeamId())),
  };
}
type Real = ReturnType<typeof realDeps>;

/* ------------------------------------------------------------------------- */

/** One removal, read from the outcome removeLeads measured — never assumed. */
function removalOutcome(p: PlannedRemoval, r: MembershipResult): CampaignOutcome {
  if (!r.ok) return { ...p, outcome: "failed", error: r.chunks.find((c) => !c.ok)?.error ?? "EmailBison refused the removal" };
  if ((r.alreadyOff ?? 0) > 0) return { ...p, outcome: "already_off" };
  if ((r.unconfirmed ?? 0) > 0) return { ...p, outcome: "failed", error: "EmailBison said the lead was not on the campaign, and that could not be confirmed" };
  return { ...p, outcome: "removed" };
}

interface Context {
  owners: Map<string, string>;
  clients: Map<string, OwnerClient>;
  switches: Map<string, ClientListSettings>;
  campaigns: Map<string, ClientCampaign[]>;
}

async function context(x: Real): Promise<Context> {
  const [clients, portals, switches] = await Promise.all([x.clients(), x.portals(), clientSwitches(x.os)]);
  return {
    owners: portalOwners(portals, clients),
    clients: new Map(clients.map((c) => [c.id, c])),
    switches,
    campaigns: new Map(),
  };
}

async function campaignsFor(x: Real, ctx: Context, client: OwnerClient): Promise<ClientCampaign[]> {
  const hit = ctx.campaigns.get(client.id);
  if (hit) return hit;
  const list = await x.campaigns(client);
  ctx.campaigns.set(client.id, list);
  return list;
}

interface Decision {
  status: RemovalStatus;
  osClientId: string | null;
  email: string | null;
  reason: string | null;
  campaigns: CampaignOutcome[];
}

type Mode = { live: true } | { live: false; reason: string };
/** Asked right before each campaign's removal: how this client's campaigns are to be treated NOW. */
type Gate = (osClientId: string) => Promise<(campaignId: string) => Mode>;

/** The gate with every switch read fresh: on, out of practice, the client's own switch, the server lock, the fence. */
async function freshGate(x: Real, osClientId: string): Promise<{ settings: ListSettings; modeFor: (campaignId: string) => Mode }> {
  const settings = await loadSettings(x.os);
  if (!settings.available || !settings.enabled) return { settings, modeFor: () => ({ live: false, reason: PRACTICE_TEXT.switched_off }) };
  const on = settings.practiceMode ? false : await clientSwitchOn(x.os, osClientId);
  return {
    settings,
    modeFor: (campaignId) => {
      const m = campaignMode(settings, on, campaignId, x.env);
      return m.live ? m : { live: false, reason: PRACTICE_TEXT[m.reason] };
    },
  };
}

/**
 * What one entry does: the reason it does nothing, or its campaigns with
 * each one's outcome. `gate` decides each campaign — practice or real.
 */
async function decide(
  x: Real,
  ctx: Context,
  entry: ListEntry,
  source: ListSource,
  gate: Gate,
): Promise<Decision> {
  const target = entryTarget(entry, source);
  const base = { osClientId: null as string | null, email: target.ok ? target.email : null, campaigns: [] as CampaignOutcome[] };
  if (!target.ok) return { ...base, status: "skipped", reason: SKIP_TEXT[target.reason] };
  if (entry.client_id === DEMO_PORTAL_ID) return { ...base, status: "skipped", reason: SKIP_TEXT.demo };
  const ownerId = ctx.owners.get(entry.client_id);
  const client = ownerId ? ctx.clients.get(ownerId) : undefined;
  if (!client) return { ...base, status: "skipped", reason: SKIP_TEXT.no_client };

  const campaigns = await campaignsFor(x, ctx, client);
  if (!campaigns.length) return { ...base, osClientId: client.id, status: "not_in_campaigns", reason: "This client has no EmailBison campaigns." };
  const plan = planRemovals(target.email, await x.findLeads(target.email), campaigns);
  const outcomes: CampaignOutcome[] = [];
  const actor = `campaign-cleanup (${source === "dnc" ? "DNC" : "My Agents"})`;
  for (const p of plan) {
    // Asked again before EVERY campaign: a switch turned off between two removals stops the second.
    const m = (await gate(client.id))(p.campaignId);
    if (!m.live) {
      outcomes.push({ ...p, outcome: "would_remove", reason: m.reason });
      continue;
    }
    try {
      outcomes.push(removalOutcome(p, await x.remove(Number(p.campaignId), [p.leadId], actor)));
    } catch (e) {
      outcomes.push({ ...p, outcome: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ...base, osClientId: client.id, status: overallStatus(outcomes), reason: null, campaigns: outcomes };
}

export interface SweepResult {
  off?: string;
  /** Why a pass ended early: its switches changed under it. The next pass starts from the new settings. */
  stopped?: string;
  seen: number;
  claimed: number;
  outcomes: Partial<Record<RemovalStatus, number>>;
  errors: string[];
}

/** A pending claim this old was left by a process that died mid-entry. */
const STALE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;
/** Entries younger than this are left for a later pass (readEntriesFromMi). */
const SETTLE_MS = 2 * 60_000;

/**
 * One pass. Its settings are read once at the start; every guard that
 * matters is then re-checked as it goes:
 *   - right before anything is removed, the switches and the client's own
 *     switch are read again (freshGate) — switched off, back in practice or
 *     changed: nothing more is removed and the pass ends;
 *   - the cursor only moves from where this pass found it (compare-and-set):
 *     if a person switched on or left practice meanwhile (which moves it to
 *     "now"), the pass ends instead of putting it back.
 */
export async function sweepCampaignRemovals(deps: SweepDeps = {}): Promise<SweepResult> {
  const x = realDeps(deps);
  const result: SweepResult = { seen: 0, claimed: 0, outcomes: {}, errors: [] };
  if (sweepSwitchedOff(x.env)) return { ...result, off: "OS_CAMPAIGN_CLEANUP=0" };
  const settings = await loadSettings(x.os);
  if (!settings.available) return { ...result, off: "migration 0042 not run" };
  if (!settings.enabled) return { ...result, off: "switched off" };
  if (!settings.cursor) {
    // On without a starting point (should not happen — saveSettings sets one): start now, act next pass.
    await x.os("os_campaign_list_settings").update({ cursor_at: x.now().toISOString(), cursor_id: null }).eq("id", "default").is("cursor_at", null);
    return result;
  }
  let cursor: Cursor = settings.cursor;

  const before = new Date(x.now().getTime() - SETTLE_MS).toISOString();
  const [agents, dnc] = await Promise.all([
    x.readEntries("my_agents", cursor, settings.perRun, before),
    x.readEntries("dnc", cursor, settings.perRun, before),
  ]);
  const queue = [
    ...agents.map((e) => ({ e, source: "my_agents" as const })),
    ...dnc.map((e) => ({ e, source: "dnc" as const })),
  ]
    .sort((a, b) => compareEntries(a.e, b.e))
    .slice(0, settings.perRun);

  const stale = await x.os("os_campaign_removals")
    .select("id, source, entry_id, attempts, decided_by, settings_version")
    .eq("status", "pending")
    .lt("updated_at", new Date(x.now().getTime() - STALE_MS).toISOString())
    .limit(5);

  if (!queue.length && !(stale.data ?? []).length) return result;
  const ctx = await context(x);
  const tally = (s: RemovalStatus) => (result.outcomes[s] = (result.outcomes[s] ?? 0) + 1);
  const gate: Gate = async (osClientId) => {
    // Practice at the start of the pass: nothing can be removed in it, whatever happens meanwhile.
    if (settings.practiceMode) return () => ({ live: false, reason: PRACTICE_TEXT.practice_mode });
    const fresh = await freshGate(x, osClientId);
    if (!fresh.settings.enabled) result.stopped = "the clean-up was switched off during this pass";
    else if (fresh.settings.updatedAt !== settings.updatedAt) result.stopped = "the switches changed during this pass";
    if (result.stopped) return () => ({ live: false, reason: fresh.settings.enabled ? "The switches changed during this pass — nothing more was removed." : PRACTICE_TEXT.switched_off });
    return fresh.modeFor;
  };

  for (const { e, source } of queue) {
    result.seen++;
    const claim = await x.os("os_campaign_removals").insert({
      dedupe_key: `${source}:${e.id}`,
      source,
      entry_id: e.id,
      entry_created_at: e.created_at,
      mi_client_id: e.client_id,
      email: e.email,
      person_name: e.name,
      status: "pending",
      attempts: 1,
      decided_by: "sweep",
      // The switches this was claimed under: a retry under any other is refused.
      settings_version: settings.updatedAt,
    }).select("id");
    // Already claimed — by an earlier pass or another process. Never twice.
    const id = !claim.error ? String(((claim.data ?? []) as Row[])[0]?.id ?? "") : "";
    if (id) {
      result.claimed++;
      await finish(x, id, e, source, ctx, gate, tally, result);
    } else if (claim.error && claim.error.code !== "23505") {
      result.errors.push(`${source} ${e.id}: ${claim.error.message}`);
      break; // the cursor stays here, so this entry is tried again next pass
    }
    // Compare-and-set: only from where this pass found the cursor.
    const move = x.os("os_campaign_list_settings").update({ cursor_at: e.created_at, cursor_id: e.id }).eq("id", "default").eq("cursor_at", cursor.at);
    const moved = await (cursor.id ? move.eq("cursor_id", cursor.id) : move.is("cursor_id", null)).select("id");
    if (moved.error) {
      result.errors.push(`cursor: ${moved.error.message}`);
      break;
    }
    if (!((moved.data ?? []) as Row[]).length) {
      result.stopped ??= "the cursor moved under this pass (a switch change, or another server's pass)";
      break;
    }
    cursor = { at: e.created_at, id: e.id };
    if (result.stopped) break;
  }

  // Entries a dead process claimed and never finished — one process each, a few tries, then failed.
  for (const r of result.stopped ? [] : ((stale.data ?? []) as Row[])) {
    if (result.stopped) break;
    const attempts = Number(r.attempts ?? 1);
    const take = await x.os("os_campaign_removals")
      .update({ attempts: attempts + 1, updated_at: x.now().toISOString() })
      .eq("id", String(r.id)).eq("status", "pending").eq("attempts", attempts)
      .select("id");
    if (take.error || !((take.data ?? []) as Row[]).length) continue; // another process has it
    // Only the sweep's own claims, made under the switches as they are now — never a person's
    // unfinished "Remove now", never an entry claimed before a switch change.
    if (r.decided_by !== "sweep" || (r.settings_version ?? null) !== settings.updatedAt) {
      await x.os("os_campaign_removals").update({
        status: r.decided_by !== "sweep" ? "failed" : "skipped",
        reason: r.decided_by !== "sweep"
          ? "A Remove now did not finish — look the entry up and press it again."
          : "The clean-up's switches changed before this entry was finished — it was not acted on.",
      }).eq("id", String(r.id));
      continue;
    }
    if (attempts >= MAX_ATTEMPTS) {
      await x.os("os_campaign_removals").update({ status: "failed", reason: `Could not be finished after ${MAX_ATTEMPTS} tries.` }).eq("id", String(r.id));
      tally("failed");
      continue;
    }
    const source: ListSource = r.source === "dnc" ? "dnc" : "my_agents";
    const { data, error } = await getMasterInboxSupabase().from(TABLE[source]).select(ENTRY_COLUMNS[source]).eq("id", String(r.entry_id)).maybeSingle();
    if (error) {
      // Not "deleted" — just unreadable right now. Left pending for another try.
      result.errors.push(`${source} ${String(r.entry_id)}: ${error.message}`);
      continue;
    }
    if (!data) {
      await x.os("os_campaign_removals").update({ status: "skipped", reason: "The entry was deleted before it was looked at." }).eq("id", String(r.id));
      continue;
    }
    await finish(x, String(r.id), data as unknown as ListEntry, source, ctx, gate, tally, result);
  }
  return result;
}

async function finish(
  x: Real,
  id: string,
  e: ListEntry,
  source: ListSource,
  ctx: Context,
  gate: Gate,
  tally: (s: RemovalStatus) => void,
  result: SweepResult,
) {
  let d: Decision;
  try {
    d = await decide(x, ctx, e, source, gate);
  } catch (err) {
    // Left pending: retried (up to MAX_ATTEMPTS) once it is STALE_MS old.
    const message = err instanceof Error ? err.message : String(err);
    await x.os("os_campaign_removals").update({ error: message, updated_at: x.now().toISOString() }).eq("id", id);
    result.errors.push(`${source} ${e.id}: ${message}`);
    return;
  }
  const record = {
    status: d.status,
    os_client_id: d.osClientId,
    email: d.email ?? e.email,
    reason: d.reason,
    campaigns: d.campaigns,
    error: d.campaigns.find((c) => c.error)?.error ?? null,
    updated_at: x.now().toISOString(),
  };
  // Twice if need be: after a real removal this row is the only record of it.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await x.os("os_campaign_removals").update(record).eq("id", id);
    if (!error) {
      tally(d.status);
      return;
    }
    if (attempt === 1) {
      console.error(`[campaign-cleanup] could not record ${source} ${e.id}: ${error.message} — what happened: ${JSON.stringify(record)}`);
      result.errors.push(`${source} ${e.id}: not recorded (${error.message})`);
    }
  }
}

/* ------------------------------------------------------------------------- */

/**
 * "Check one email": what the clean-up would do for this client and address
 * RIGHT NOW, without changing anything — one EmailBison read.
 */
export async function checkEmail(osClientId: string, rawEmail: string, deps: SweepDeps = {}) {
  const x = realDeps(deps);
  const target = entryTarget({ email: rawEmail }, "my_agents");
  if (!target.ok) throw new CampaignListError("Enter one email address.");
  const clients = await x.clients();
  const client = clients.find((c) => c.id === osClientId);
  if (!client) throw new CampaignListError("No such client.", 404);
  const [settings, switches, campaigns] = await Promise.all([loadSettings(x.os), clientSwitches(x.os), x.campaigns(client)]);
  const plan = campaigns.length ? planRemovals(target.email, await x.findLeads(target.email), campaigns) : [];
  const clientOn = switches.get(client.id)?.removeEnabled === true;
  return {
    client: { id: client.id, name: client.name },
    email: target.email,
    campaignsChecked: campaigns.length,
    clientSwitchOn: clientOn,
    rows: plan.map((p) => {
      const m = settings.enabled ? campaignMode(settings, clientOn, p.campaignId, x.env) : null;
      return { ...p, wouldBe: m === null ? "off" : m.live ? "removed" : "practice", reason: m === null ? "The clean-up is switched off." : m.live ? null : PRACTICE_TEXT[m.reason] };
    }),
  };
}

/**
 * "Remove now" on one recorded entry (admins) — a retry of a failed or
 * partly removed entry, or one practised earlier. Exactly the same gates as
 * the sweep, all read fresh: the clean-up on, out of practice, this client's
 * own switch on, OS_CAMPAIGN_CLEANUP_LIVE=1, and the test fence. One press
 * acts once (a conditional claim on the record). The person is looked up
 * again first; the record may be days old.
 */
export async function removeNow(rowId: string, who: string, deps: SweepDeps = {}) {
  const x = realDeps(deps);
  if (!liveAllowed(x.env)) throw new CampaignListError("Removing is locked on this server (OS_CAMPAIGN_CLEANUP_LIVE is not 1). Nothing was changed.", 409);
  const { data, error } = await x.os("os_campaign_removals").select("*").eq("id", rowId).maybeSingle();
  if (error) throw new CampaignListError(error.message, 502);
  const row = (data ?? null) as Row | null;
  if (!row) throw new CampaignListError("No such record.", 404);
  if (!["practice", "partly_removed", "failed"].includes(String(row.status))) throw new CampaignListError("Only a practised, partly removed or failed entry can be removed now.", 409);
  const osClientId = typeof row.os_client_id === "string" ? row.os_client_id : null;
  if (!osClientId) throw new CampaignListError("This entry belongs to no client.", 409);
  const settings = await loadSettings(x.os);
  if (!settings.enabled) throw new CampaignListError("The clean-up is switched off. Nothing was changed.", 409);
  if (settings.practiceMode) throw new CampaignListError("The clean-up is in practice mode. Nothing was changed.", 409);
  if (!(await clientSwitchOn(x.os, osClientId))) throw new CampaignListError("This client's own switch is off (client record → Campaigns). Nothing was changed.", 409);

  const source: ListSource = row.source === "dnc" ? "dnc" : "my_agents";
  const entry = await getMasterInboxSupabase().from(TABLE[source]).select(ENTRY_COLUMNS[source]).eq("id", String(row.entry_id)).maybeSingle();
  if (entry.error) throw new CampaignListError(entry.error.message, 502);
  if (!entry.data) throw new CampaignListError("That entry is no longer on the portal's list — nothing was removed.", 409);

  // One press acts once: claim the record from exactly the state it was read in.
  const attempts = Number(row.attempts ?? 1);
  const take = await x.os("os_campaign_removals")
    .update({ status: "pending", attempts: attempts + 1, decided_by: who, updated_at: x.now().toISOString() })
    .eq("id", rowId).eq("status", String(row.status)).eq("attempts", attempts)
    .select("id");
  if (take.error) throw new CampaignListError(take.error.message, 502);
  if (!((take.data ?? []) as Row[]).length) throw new CampaignListError("Someone else is already acting on this entry.", 409);

  let d: Decision;
  try {
    const ctx = await context(x);
    d = await decide(x, ctx, entry.data as unknown as ListEntry, source, async (clientId) => (await freshGate(x, clientId)).modeFor);
  } catch (e) {
    await x.os("os_campaign_removals").update({ status: String(row.status), error: e instanceof Error ? e.message : String(e), updated_at: x.now().toISOString() }).eq("id", rowId);
    throw e;
  }
  // Earlier removals on this record stay counted; the fresh look-up no longer lists those campaigns.
  const earlier = ((row.campaigns ?? []) as CampaignOutcome[]).filter((c) => (c.outcome === "removed" || c.outcome === "already_off") && !d.campaigns.some((n) => n.campaignId === c.campaignId));
  const campaigns = [...earlier, ...d.campaigns];
  const status = d.status === "skipped" ? "skipped" : overallStatus(campaigns);
  const record = { status, reason: d.reason, campaigns, error: d.campaigns.find((c) => c.error)?.error ?? null, updated_at: x.now().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error: wErr } = await x.os("os_campaign_removals").update(record).eq("id", rowId);
    if (!wErr) return { status, campaigns };
    if (attempt === 1) {
      console.error(`[campaign-cleanup] could not record Remove now on ${rowId}: ${wErr.message} — what happened: ${JSON.stringify(record)}`);
      throw new CampaignListError(`Done, but the record could not be saved (${wErr.message}). What happened is in the server log.`, 502);
    }
  }
  return { status, campaigns };
}

/* ------------------------------------------------------------------------- */

export interface RemovalRow {
  id: string;
  source: ListSource;
  osClientId: string | null;
  clientName: string | null;
  email: string | null;
  personName: string | null;
  status: RemovalStatus;
  reason: string | null;
  campaigns: CampaignOutcome[];
  error: string | null;
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function removalFromRow(r: Row, names: Map<string, string>): RemovalRow {
  const osClientId = typeof r.os_client_id === "string" ? r.os_client_id : null;
  return {
    id: String(r.id),
    source: r.source === "dnc" ? "dnc" : "my_agents",
    osClientId,
    clientName: osClientId ? names.get(osClientId) ?? null : null,
    email: typeof r.email === "string" ? r.email : null,
    personName: typeof r.person_name === "string" ? r.person_name : null,
    status: String(r.status) as RemovalStatus,
    reason: typeof r.reason === "string" ? r.reason : null,
    campaigns: Array.isArray(r.campaigns) ? (r.campaigns as CampaignOutcome[]) : [],
    error: typeof r.error === "string" ? r.error : null,
    decidedBy: typeof r.decided_by === "string" ? r.decided_by : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

async function clientNames(os: Os): Promise<Map<string, string>> {
  const { data } = await os("os_clients").select("id, name");
  return new Map(((data ?? []) as unknown as { id: string; name: string }[]).map((r) => [r.id, r.name]));
}

export async function recentRemovals(osClientId?: string, limit = 50, os: Os = osTable): Promise<RemovalRow[]> {
  let q = os("os_campaign_removals").select("*");
  if (osClientId) q = q.eq("os_client_id", osClientId);
  const [{ data, error }, names] = await Promise.all([q.order("created_at", { ascending: false }).limit(limit), clientNames(os)]);
  if (error) return [];
  return ((data ?? []) as Row[]).map((r) => removalFromRow(r, names));
}

export interface CleanupOverview {
  settings: ListSettings;
  server: { liveAllowed: boolean; liveOnly: string[] | null };
  clientsOn: { id: string; name: string }[];
  clients: { id: string; name: string }[];
  counts: Partial<Record<RemovalStatus, number>>;
  recent: RemovalRow[];
}

export async function cleanupOverview(deps: SweepDeps = {}): Promise<CleanupOverview> {
  const x = realDeps(deps);
  const settings = await loadSettings(x.os);
  const server = { liveAllowed: liveAllowed(x.env), liveOnly: liveOnlyCampaigns(x.env) };
  if (!settings.available) return { settings, server, clientsOn: [], clients: [], counts: {}, recent: [] };
  const [switches, names, recent, week] = await Promise.all([
    clientSwitches(x.os),
    clientNames(x.os),
    recentRemovals(undefined, 50, x.os),
    x.os("os_campaign_removals").select("status").gte("created_at", new Date(x.now().getTime() - 7 * 86_400_000).toISOString()).limit(5000),
  ]);
  const counts: Partial<Record<RemovalStatus, number>> = {};
  for (const r of (week.data ?? []) as Row[]) counts[String(r.status) as RemovalStatus] = (counts[String(r.status) as RemovalStatus] ?? 0) + 1;
  const list = await x.clients();
  return {
    settings,
    server,
    clientsOn: [...switches].filter(([, s]) => s.removeEnabled).map(([id]) => ({ id, name: names.get(id) ?? id })),
    clients: list.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
    counts,
    recent,
  };
}

/* ------------------------------------------------------------------------- */

/** One client's switch, Prospects campaign, its EmailBison campaigns to pick from, and its recent entries. */
export async function clientListView(osClientId: string, deps: SweepDeps = {}) {
  const x = realDeps(deps);
  const settings = await loadSettings(x.os);
  if (!settings.available) return { available: false as const };
  const clients = await x.clients();
  const client = clients.find((c) => c.id === osClientId);
  if (!client) throw new CampaignListError("No such client.", 404);
  const [row, campaigns, recent] = await Promise.all([
    x.os("os_campaign_list_clients").select("*").eq("os_client_id", osClientId).maybeSingle(),
    x.campaigns(client).catch(() => [] as ClientCampaign[]),
    recentRemovals(osClientId, 20, x.os),
  ]);
  return {
    available: true as const,
    global: { enabled: settings.enabled, practiceMode: settings.practiceMode },
    server: { liveAllowed: liveAllowed(x.env) },
    client: clientFromRow((row.data ?? null) as Row | null),
    campaigns,
    recent,
  };
}

/** { removeEnabled?, prospectsCampaignId? (null clears), ifUpdatedAt? } — the campaign must be one of the client's own. */
export async function saveClientListSettings(osClientId: string, body: unknown, who: string, deps: SweepDeps = {}) {
  const x = realDeps(deps);
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const settings = await loadSettings(x.os);
  if (!settings.available) throw new CampaignListError(MIGRATION, 409);
  const { data, error } = await x.os("os_campaign_list_clients").select("*").eq("os_client_id", osClientId).maybeSingle();
  if (error) throw new CampaignListError(error.message, 502);
  const current = clientFromRow((data ?? null) as Row | null);
  if ("ifUpdatedAt" in b && (b.ifUpdatedAt ?? null) !== current.updatedAt) {
    throw new CampaignListError("This client's settings were changed by someone else since this page was opened — nothing was saved. Reload and try again.", 409);
  }
  if ("removeEnabled" in b && typeof b.removeEnabled !== "boolean") throw new CampaignListError("removeEnabled must be true or false.");
  const patch: Row = {
    os_client_id: osClientId,
    remove_enabled: typeof b.removeEnabled === "boolean" ? b.removeEnabled : current.removeEnabled,
    prospects_campaign_id: current.prospectsCampaignId,
    prospects_campaign_name: current.prospectsCampaignName,
    updated_at: x.now().toISOString(),
    updated_by: who,
  };
  if ("prospectsCampaignId" in b) {
    const want = b.prospectsCampaignId;
    if (want === null || want === "") {
      patch.prospects_campaign_id = null;
      patch.prospects_campaign_name = null;
    } else {
      const client = (await x.clients()).find((c) => c.id === osClientId);
      if (!client) throw new CampaignListError("No such client.", 404);
      const c = (await x.campaigns(client)).find((k) => k.id === String(want));
      if (!c) throw new CampaignListError("That campaign is not one of this client's EmailBison campaigns.");
      patch.prospects_campaign_id = c.id;
      patch.prospects_campaign_name = c.name;
    }
  }
  const saved = await x.os("os_campaign_list_clients").upsert(patch, { onConflict: "os_client_id" });
  if (saved.error) throw new CampaignListError(saved.error.message, 502);
  return clientFromRow(patch);
}
