import "server-only";

import { createEmailBisonClient, EmailBisonApiError } from "@/lib/tools/analytics/emailbison/client.ts";

import { pooled, SENDING_STATUSES } from "./inbox-extras.ts";
import { activeInboxCapacity, type ActiveInboxCapacity, type CampaignInbox } from "./sending-capacity.ts";
import { analyticsTeamId, getAnalyticsSupabase } from "./supabase";

/*
 * Which inboxes each campaign holds, read from EmailBison and kept here (5 Nov). Nothing in the database records it,
 * and a list is 15 rows a read: 1,630 inboxes is 109 reads, about half a minute. Two things need it:
 *
 *   the Campaigns page's "Active inboxes"      every active campaign's list, added up
 *   the Inboxes page's remove from campaigns   which selected inboxes each campaign holds
 *
 * Kept in the process, as inbox-extras-load.ts keeps its read: a restart simply reads again on the next visit. A read
 * is never started by the clock, only by someone asking.
 *
 * Read-only: every request here is a GET.
 */

/** A campaign's list is used for this long for the Active inboxes figure. */
const TTL_MS = 60 * 60 * 1000;
/*
 * And for this long when a removal rests on it. Swapping one inbox for another keeps the same size, so comparing sizes
 * can't see it, and replacing inboxes is what this feature is for: an inbox missed here goes on sending.
 */
const REMOVAL_TTL_MS = 5 * 60 * 1000;
/** After a failed read, wait this long before the next visit tries again. */
const RETRY_MS = 5 * 60 * 1000;
/** Campaign reads in flight at once for the Active inboxes figure: it mustn't take the rate budget from the screens. */
const ACTIVE_READS_AT_ONCE = 3;

interface Entry {
  inboxes: CampaignInbox[];
  readAt: number;
}

interface ActiveJob {
  reading: Promise<void> | null;
  done: number;
  total: number;
  error: string | null;
  failedAt: number | null;
}

interface State {
  entries: Map<number, Entry>;
  walks: Map<number, Promise<Entry>>;
  /** Inboxes taken off while a campaign's list was being read: that read may still hold them. */
  takenOff: Map<number, Set<number>>;
  active: ActiveJob;
}

// One state for the whole process: Next builds this module more than once (see cache/ttl.ts `shared`).
const SLOT = Symbol.for("os.analytics.campaignInboxes");
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[SLOT] ??= { entries: new Map(), walks: new Map(), takenOff: new Map(), active: { reading: null, done: 0, total: 0, error: null, failedAt: null } });
}

/** Reads one campaign's list, once however many ask at the same moment. */
function readCampaign(campaignId: number): Promise<Entry> {
  const s = state();
  const running = s.walks.get(campaignId);
  if (running) return running;
  const walk = createEmailBisonClient()
    .getCampaignSenderEmails(campaignId)
    .then((rows) => {
      const gone = s.takenOff.get(campaignId);
      s.takenOff.delete(campaignId);
      const entry: Entry = {
        inboxes: rows.map((r) => ({ id: Number(r.id), status: r.status ?? null, dailyLimit: r.daily_limit ?? null })).filter((i) => !gone?.has(i.id)),
        readAt: Date.now(),
      };
      s.entries.set(campaignId, entry);
      return entry;
    })
    .catch((e: unknown) => {
      // Deleted between the list of campaigns and this read: it holds nothing.
      if (e instanceof EmailBisonApiError && e.statusCode === 404) {
        const entry: Entry = { inboxes: [], readAt: Date.now() };
        s.entries.set(campaignId, entry);
        return entry;
      }
      throw e;
    })
    .finally(() => s.walks.delete(campaignId));
  s.walks.set(campaignId, walk);
  return walk;
}

/**
 * Which of these inboxes this campaign holds, and how many it holds in all.
 *
 * `count` is the campaign's count from a moment ago. A kept list of any other size has changed since it was read, so
 * it is read again: this is the question a removal rests on, and the two are one cheap comparison apart.
 */
export async function campaignOverlap(campaignId: number, count: number, inboxIds: readonly number[]): Promise<{ on: number[]; total: number; leftConnected: number }> {
  const kept = state().entries.get(campaignId);
  const entry = kept && Date.now() - kept.readAt < REMOVAL_TTL_MS && kept.inboxes.length === count ? kept : await readCampaign(campaignId);
  const asked = new Set(inboxIds);
  return {
    on: entry.inboxes.filter((i) => asked.has(i.id)).map((i) => i.id),
    total: entry.inboxes.length,
    leftConnected: entry.inboxes.filter((i) => !asked.has(i.id) && i.status === "Connected").length,
  };
}

/** Inboxes a removal has just taken off: the kept list stays right, and needs no new read. */
export function inboxesTakenOff(campaignId: number, inboxIds: readonly number[]): void {
  if (!inboxIds.length) return;
  const s = state();
  const gone = new Set(inboxIds);
  // A read running now may have passed them already, and would put them back.
  if (s.walks.has(campaignId)) s.takenOff.set(campaignId, new Set([...(s.takenOff.get(campaignId) ?? []), ...gone]));
  const entry = s.entries.get(campaignId);
  if (entry) entry.inboxes = entry.inboxes.filter((i) => !gone.has(i.id));
}

export interface ActiveCapacitySnapshot {
  /** ready: `active` is current. refreshing: `active` is the last read and a new one is running. loading: nothing yet. error: see `error`. */
  status: "ready" | "refreshing" | "loading" | "error";
  active: ActiveInboxCapacity | null;
  /** The oldest list behind the figure. */
  asOf: string | null;
  progress: { done: number; total: number } | null;
  error: string | null;
}

/** The inboxes on active campaigns, as far as known; if that is nothing or stale, starts a read behind the answer. */
export async function activeCapacity(now = Date.now()): Promise<ActiveCapacitySnapshot> {
  const { data, error } = await getAnalyticsSupabase()
    .from("campaigns")
    .select("id")
    .eq("team_id", analyticsTeamId())
    // A campaign resumed a moment ago is `queued`: counting only `active` would drop its inboxes until it moved.
    .in("status", [...SENDING_STATUSES])
    .is("deleted_at", null);
  if (error) throw new Error(`Active campaigns: ${error.message}`);
  const ids = ((data ?? []) as Array<{ id: number }>).map((c) => Number(c.id));

  const s = state();
  const job = s.active;
  const stale = ids.filter((id) => {
    const entry = s.entries.get(id);
    return !entry || now - entry.readAt >= TTL_MS;
  });
  const coolingOff = job.failedAt !== null && now - job.failedAt < RETRY_MS;

  if (stale.length && !job.reading && !coolingOff) {
    job.error = null;
    job.done = 0;
    job.total = stale.length;
    job.reading = pooled(stale, ACTIVE_READS_AT_ONCE, async (id) => {
      await readCampaign(id);
      job.done++;
    })
      .then(() => { job.failedAt = null; })
      .catch((e: unknown) => {
        job.error = e instanceof Error ? e.message : "EmailBison did not answer";
        job.failedAt = Date.now();
        console.error("[analytics] active inboxes:", job.error);
      })
      .finally(() => { job.reading = null; });
  }

  const entries = ids.map((id) => s.entries.get(id));
  const complete = entries.every((e): e is Entry => !!e);
  const progress = job.reading ? { done: job.done, total: job.total } : null;
  if (!complete) {
    return { status: job.reading ? "loading" : "error", active: null, asOf: null, progress, error: job.reading ? null : job.error ?? "The figure isn't ready yet." };
  }
  const lists = entries as Entry[];
  return {
    status: job.reading ? "refreshing" : "ready",
    active: activeInboxCapacity(lists.map((e) => e.inboxes)),
    asOf: lists.length ? new Date(Math.min(...lists.map((e) => e.readAt))).toISOString() : null,
    progress,
    error: null,
  };
}
