import "server-only";

// Play/Pause every campaign for one client, from the Weekly table.
//
// PORTED from the tool's lib/campaign-toggle.ts (1590588). Same rules, same
// tables, same log — both apps write the shared toggle_paused_campaigns, so a
// campaign paused from one shows ▶ in the other. The one structural change:
// the decisions (what to change, what to skip and why, what stays held) are
// pure functions below, so the invariants in the port document §6.4 are
// tested without calling Instantly or Bison.
//
// Campaigns only: a client's status, portal and billing are never touched
// here — that is the separate Paused / Churned lifecycle.
//
// PAUSE acts on every linked campaign that can currently send, and records
// exactly which ones it paused on the client row (toggle_paused_campaigns).
// PLAY resumes only that recorded set. A finished campaign, or one somebody
// paused by hand, is never restarted by this button. That matters because on
// Bison "resume" is not an undo: it queues the campaign to email its
// remaining leads.
//
// Statuses are read LIVE from Instantly and Bison at plan time, not from the
// 15-minute cache, and each campaign reports its own outcome — a fan-out can
// half-succeed, and "5 of 6 paused, 1 failed: <reason>" is the honest answer.

import { getSupabase } from './supabase';
import { activateCampaign, getCampaignStatus, pauseCampaign } from './sync/instantly';
import { getBisonCampaignStatus, pauseBisonCampaign, resumeBisonCampaign } from './sync/bison';
import type { ToggledCampaign } from './types';

export type ToggleAction = 'pause' | 'resume';

export interface PlannedCampaign {
  platform: 'instantly' | 'bison';
  id: string;
  int_id: number | null;
  name: string;
  /** Live status word, e.g. "active", "paused", "completed". */
  status: string;
}

export interface TogglePlan {
  clientId: string;
  clientName: string;
  action: ToggleAction;
  willChange: PlannedCampaign[];
  skipped: { campaign: PlannedCampaign; reason: string }[];
}

export interface ToggleOutcome {
  campaign: PlannedCampaign;
  ok: boolean;
  error?: string;
}

export interface ToggleResult {
  plan: TogglePlan;
  outcomes: ToggleOutcome[];
  /** Campaigns the toggle is still holding paused after this run. */
  heldPaused: number;
  /** That list itself, so the screen can show ▶ / ⏸ without waiting for a reload. */
  held: ToggledCampaign[];
}

const INSTANTLY_WORD: Record<number, string> = { 0: 'draft', 1: 'active', 2: 'paused', 3: 'completed' };
/** States in which a Bison campaign can send (mirrors Analytics' canApply("pause")). */
const BISON_SENDING = new Set(['active', 'queued', 'launching']);

export function instantlyWord(n: number | null): string {
  return n === null ? 'unknown' : INSTANTLY_WORD[n] ?? `status ${n}`;
}

export const isSending = (c: Pick<PlannedCampaign, 'platform' | 'status'>): boolean =>
  c.platform === 'instantly' ? c.status === 'active' : BISON_SENDING.has(c.status);

/** Splits live-status campaigns into what this action changes and what it leaves alone, with why. */
export function classify(
  action: ToggleAction,
  campaigns: PlannedCampaign[],
): Pick<TogglePlan, 'willChange' | 'skipped'> {
  const willChange: PlannedCampaign[] = [];
  const skipped: TogglePlan['skipped'] = [];
  for (const c of campaigns) {
    if (action === 'pause') {
      if (isSending(c)) willChange.push(c);
      else
        skipped.push({
          campaign: c,
          reason:
            c.status === 'paused' ? 'already paused'
            : c.status === 'completed' ? 'finished — nothing left to send'
            : c.status === 'draft' ? 'draft — has never sent'
            : c.status === 'deleted' ? 'no longer exists on the platform'
            : c.status === 'unreachable' ? 'platform could not be reached'
            : `status "${c.status}" cannot be paused`,
        });
    } else if (c.status === 'paused') {
      willChange.push(c);
    } else {
      skipped.push({
        campaign: c,
        reason:
          isSending(c) ? 'already running'
          : c.status === 'completed' ? 'finished since it was paused'
          : c.status === 'deleted' ? 'no longer exists on the platform'
          : c.status === 'unreachable' ? 'platform could not be reached'
          : `status "${c.status}" — not resumed`,
      });
    }
  }
  return { willChange, skipped };
}

/**
 * What the toggle holds paused after a run. Pause appends every campaign it
 * paused (de-duplicated by platform:id, keeping Bison's int_id). Play drops
 * every one it resumed, plus any that are running, finished or deleted since —
 * nothing is left for Play to do there. An unreachable one stays held.
 */
export function nextHeld(
  prev: ToggledCampaign[],
  action: ToggleAction,
  plan: Pick<TogglePlan, 'skipped'>,
  outcomes: ToggleOutcome[],
  nowIso: string,
): ToggledCampaign[] {
  const key = (c: { platform: string; id: string }) => `${c.platform}:${c.id}`;
  const held = new Map(prev.map((c) => [key(c), c]));
  if (action === 'pause') {
    for (const o of outcomes) {
      if (!o.ok) continue;
      held.set(key(o.campaign), {
        platform: o.campaign.platform,
        id: o.campaign.id,
        int_id: o.campaign.int_id,
        name: o.campaign.name,
        paused_at: nowIso,
      });
    }
  } else {
    for (const o of outcomes) if (o.ok) held.delete(key(o.campaign));
    for (const s of plan.skipped) {
      if (s.campaign.status !== 'unreachable') held.delete(key(s.campaign));
    }
  }
  return [...held.values()];
}

interface ClientRow {
  id: string;
  name: string;
  instantly_campaign_ids: string[] | null;
  bison_campaign_ids: string[] | null;
  toggle_paused_campaigns: ToggledCampaign[] | null;
}

async function loadClient(clientId: string): Promise<ClientRow> {
  const { data, error } = await getSupabase()
    .from('clients')
    .select('id, name, instantly_campaign_ids, bison_campaign_ids, toggle_paused_campaigns')
    .eq('id', clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('client not found');
  return data as ClientRow;
}

async function liveStatus(c: Omit<PlannedCampaign, 'status'>): Promise<string> {
  try {
    if (c.platform === 'instantly') return instantlyWord(await getCampaignStatus(c.id));
    if (c.int_id == null) return 'unknown';
    return (await getBisonCampaignStatus(c.int_id)) ?? 'unknown';
  } catch (err) {
    const msg = (err as Error).message;
    return / 404/.test(msg) ? 'deleted' : 'unreachable';
  }
}

/** The preview: live statuses, what would change and what would be skipped. Sends nothing. */
export async function planToggle(clientId: string, action: ToggleAction): Promise<TogglePlan> {
  const client = await loadClient(clientId);

  const held = client.toggle_paused_campaigns ?? [];
  if (action === 'resume' && held.length) {
    // Resume exactly what this toggle paused.
    const mine = held.map((c) => ({ platform: c.platform, id: c.id, int_id: c.int_id ?? null, name: c.name }));
    const withStatus: PlannedCampaign[] = await Promise.all(mine.map(async (c) => ({ ...c, status: await liveStatus(c) })));
    const plan = classify(action, withStatus);
    if (plan.willChange.length) return { clientId, clientName: client.name, action, ...plan };
    /*
     * Nothing this toggle held is still paused — finished, or resumed
     * elsewhere (22 Oct audit). Then plan as if nothing were held, so a
     * campaign paused directly in EmailBison can still be resumed from ▶;
     * the stale held entries come back as skipped, and applyToggle's
     * nextHeld drops them.
     */
  }

  return { clientId, clientName: client.name, action, ...classify(action, await linkedWithStatus(client)) };
}

/*
 * Pause: every linked campaign. Resume with nothing held here: every
 * linked campaign too — campaigns paused ELSEWHERE (in EmailBison, or by a
 * status change) left ▶ unusable (Eddy, 30 Sep: "on 54 Realty I cannot
 * press play"). `classify` still resumes only the ones live-paused right
 * now, and the dialog previews exactly which before anything is sent.
 */
async function linkedWithStatus(client: ClientRow): Promise<PlannedCampaign[]> {
  const sb = getSupabase();
  const instIds = client.instantly_campaign_ids ?? [];
  const bisonIds = client.bison_campaign_ids ?? [];
  const [inst, bison] = await Promise.all([
    instIds.length
      ? sb.from('instantly_campaigns').select('id, name').in('id', instIds)
      : Promise.resolve({ data: [], error: null }),
    bisonIds.length
      ? sb.from('bison_campaigns').select('id, int_id, name').in('id', bisonIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (inst.error) throw new Error(inst.error.message);
  if (bison.error) throw new Error(bison.error.message);
  const candidates: Omit<PlannedCampaign, 'status'>[] = [
    ...((inst.data ?? []) as { id: string; name: string }[]).map((c) => ({
      platform: 'instantly' as const, id: c.id, int_id: null, name: c.name,
    })),
    ...((bison.data ?? []) as { id: string; int_id: number | null; name: string }[]).map((c) => ({
      platform: 'bison' as const, id: c.id, int_id: c.int_id, name: c.name,
    })),
  ];
  return Promise.all(candidates.map(async (c) => ({ ...c, status: await liveStatus(c) })));
}

/** Every campaign linked to a client, with its live status. Reads only. */
export async function liveCampaigns(clientId: string): Promise<PlannedCampaign[]> {
  return linkedWithStatus(await loadClient(clientId));
}

async function applyOne(action: ToggleAction, c: PlannedCampaign): Promise<ToggleOutcome> {
  try {
    if (c.platform === 'instantly') {
      await (action === 'pause' ? pauseCampaign(c.id) : activateCampaign(c.id));
    } else {
      if (c.int_id == null) throw new Error('Bison integer id unknown — run a sync first');
      await (action === 'pause' ? pauseBisonCampaign(c.int_id) : resumeBisonCampaign(c.int_id));
    }
    return { campaign: c, ok: true };
  } catch (err) {
    return { campaign: c, ok: false, error: (err as Error).message };
  }
}

/**
 * Re-plans from live statuses (never trusts a preview the browser held for a
 * while), applies, records what the toggle now holds paused, refreshes the
 * local campaign cache for the rows it changed, and logs the attempt.
 */
export async function applyToggle(
  clientId: string,
  action: ToggleAction,
  actor: string | null,
): Promise<ToggleResult> {
  return applyPlanned(await planToggle(clientId, action), actor);
}

type ListedCampaign = Pick<ToggledCampaign, 'platform' | 'id' | 'int_id' | 'name'>;

/** Exactly these campaigns, as they are live right now, and only while they are still linked to this client. */
async function applyListed(clientId: string, action: ToggleAction, list: ListedCampaign[], actor: string | null): Promise<ToggleResult> {
  const client = await loadClient(clientId);
  const key = (c: { platform: string; id: string }) => `${c.platform}:${c.id}`;
  const linked = new Map((await linkedWithStatus(client)).map((c) => [key(c), c]));
  const plan = classify(action, list.flatMap((c) => linked.get(key(c)) ?? []));
  const gone = list.filter((c) => !linked.has(key(c))).map((c) => ({
    campaign: { platform: c.platform, id: c.id, int_id: c.int_id ?? null, name: c.name, status: 'not linked' },
    reason: 'no longer linked to this client',
  }));
  return applyPlanned({ clientId, clientName: client.name, action, willChange: plan.willChange, skipped: [...plan.skipped, ...gone] }, actor);
}

/**
 * Resumes exactly these campaigns, the ones that are live-paused right now, and nothing else: unlike Play it never
 * falls back to every linked campaign, so one a person paused by hand stays paused. The lead cap's restart.
 */
export async function resumeListed(clientId: string, list: ListedCampaign[], actor: string | null): Promise<ToggleResult> {
  return applyListed(clientId, 'resume', list, actor);
}

/** Pauses exactly these campaigns, the ones that can send right now. The lead cap's pause, which leaves out shared ones. */
export async function pauseListed(clientId: string, list: ListedCampaign[], actor: string | null): Promise<ToggleResult> {
  return applyListed(clientId, 'pause', list, actor);
}

/**
 * Which of these campaigns are linked to another client too, and which clients. Linking goes by name, so it does
 * happen (Douglas Elliman Las Vegas and Los Angeles share 11 today): pausing one stops every client on it. Reads only.
 */
export async function sharedWithOthers(clientId: string, list: { platform: 'instantly' | 'bison'; id: string }[]): Promise<Map<string, string[]>> {
  const { data, error } = await getSupabase().from('clients').select('id, name, instantly_campaign_ids, bison_campaign_ids').neq('id', clientId);
  if (error) throw new Error(error.message);
  const others = (data ?? []) as Pick<ClientRow, 'id' | 'name' | 'instantly_campaign_ids' | 'bison_campaign_ids'>[];
  const out = new Map<string, string[]>();
  for (const c of list) {
    const also = others.filter((o) => (c.platform === 'bison' ? o.bison_campaign_ids : o.instantly_campaign_ids)?.includes(c.id)).map((o) => o.name);
    if (also.length) out.set(`${c.platform}:${c.id}`, also);
  }
  return out;
}

async function applyPlanned(plan: TogglePlan, actor: string | null): Promise<ToggleResult> {
  const { clientId, action } = plan;
  const outcomes = await Promise.all(plan.willChange.map((c) => applyOne(action, c)));
  const sb = getSupabase();
  const now = new Date().toISOString();

  // Re-read: another app may have written the held list while this ran.
  const client = await loadClient(clientId);
  const heldList = nextHeld(client.toggle_paused_campaigns ?? [], action, plan, outcomes, now);
  const { error: holdErr } = await sb
    .from('clients')
    .update({ toggle_paused_campaigns: heldList })
    .eq('id', clientId);
  if (holdErr) console.warn(`[campaign-toggle] could not record held campaigns: ${holdErr.message}`);

  // Reflect the change now instead of after the next 15-minute sync.
  const newStatus = action === 'pause' ? 'paused' : 'running';
  for (const o of outcomes) {
    if (!o.ok) continue;
    const table = o.campaign.platform === 'instantly' ? 'instantly_campaigns' : 'bison_campaigns';
    await sb.from(table).update({ status: newStatus, status_changed_at: now }).eq('id', o.campaign.id);
  }

  const { error: logErr } = await sb.from('campaign_toggle_log').insert({
    client_id: clientId,
    client_name: plan.clientName,
    action,
    actor,
    results: {
      changed: outcomes.map((o) => ({
        platform: o.campaign.platform, id: o.campaign.id, name: o.campaign.name,
        ok: o.ok, error: o.error ?? null,
      })),
      skipped: plan.skipped.map((s) => ({
        platform: s.campaign.platform, id: s.campaign.id, name: s.campaign.name, reason: s.reason,
      })),
    },
  });
  if (logErr) console.warn(`[campaign-toggle] log insert failed: ${logErr.message}`);

  return { plan, outcomes, heldPaused: heldList.length, held: heldList };
}
