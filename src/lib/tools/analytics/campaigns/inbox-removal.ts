import { describeEmailBisonError, invalidIndices } from "../emailbison/errors.ts";
import { pooled } from "../inbox-extras.ts";

import { canApply } from "./status.ts";

/*
 * Taking inboxes off every campaign at once, from the Inboxes page (5 Nov; client: "select a group or tag of inboxes and
 * remove them from all campaigns at once, instead of removing them from each campaign one by one").
 *
 * What EmailBison makes this be:
 *
 *   ONLY DRAFT OR PAUSED. "The campaign must be in a draft or paused state to remove sender emails". An active campaign
 *   has to be paused first and started again after. That stops real sending for a moment, so it is its own tick in the
 *   dialog, off until someone turns it on, and only the campaigns this run paused are ever started again.
 *
 *   NEVER EMPTY. EmailBison archives a paused campaign with no inboxes within minutes, and later deletes it. So a
 *   campaign these inboxes would leave with none is left exactly as it is, and said so. Checked against a fresh count
 *   before every call, whatever the review said: someone else may be taking inboxes off it too.
 *
 *   A PAUSED CAMPAIGN'S REMOVAL HAPPENS A MOMENT LATER. It answers "Sender emails sent for deletion. This may take a
 *   moment", and the list changes 2 to 3 seconds on (measured 5 Nov on a test campaign: the same for 1, 10 or 250
 *   inboxes; a draft's is at once). So each call is waited for, by the campaign's own count, before the next one, and
 *   above all before an active campaign is started again.
 *
 *   RESUME IS NOT AN UNDO. It starts whatever is paused: a finished campaign paused and resumed emails everyone on it
 *   again. So a campaign is paused only straight after being read as sending, and started again only if this run saw it
 *   paused. A lost answer doesn't mean nothing happened, so it is read rather than assumed, and anything still unclear
 *   is said to be unclear instead of being tried again.
 *
 *   NO BULK CALL. One call a campaign, with only ids that campaign holds: one id it doesn't hold refuses the whole call
 *   ("The selected sender_email_ids.110 is invalid"). A campaign's list is read 15 rows at a time, a pool of 1,630 is
 *   109 reads, and 66 open campaigns is about 4,700. An inbox's own list is cheaper for a few inboxes, so a small
 *   selection asks the inboxes and a large one asks the campaigns.
 *
 * Finished and archived campaigns can't be changed and can't send, so they aren't looked at.
 *
 * Pure: the EmailBison calls are passed in.
 */

/** The statuses that matter here: they can be changed, or paused and then changed. */
export const OPEN_STATUSES = ["draft", "paused", "active", "queued", "launching"] as const;
/** Up to this many inboxes are asked about one by one; more, and every campaign is read instead. */
export const ASK_INBOXES_UP_TO = 30;
/** Inboxes in one request to the by-inbox route. */
export const INBOXES_PER_ASK = 5;
/** Campaign reads in flight at once: each is a walk of up to 150 pages. */
export const CAMPAIGN_READS_AT_ONCE = 6;
/** A remove call's ids. As the campaign page's own pool remove. */
export const REMOVE_CHUNK = 250;
/** Fewer than this left afterwards is pointed out in the review. */
export const LOW_LEFT = 5;
/** A campaign left with this few or fewer is checked for whether any of them can send. */
export const READ_CAMPAIGN_IF_LEFT = 60;

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const canChangeNow = (status: string) => status === "draft" || status === "paused";

export function isOpenStatus(status: string | null | undefined): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(norm(status));
}

/** An open campaign, as EmailBison has it right now. */
export interface OpenCampaign {
  id: number;
  name: string;
  status: string;
  /** Inboxes on it now. */
  inboxes: number;
}

/* ------------------------------------------------------------ the check --- */

export interface CheckApi {
  /** Inbox id → the ids of every campaign it is on. At most INBOXES_PER_ASK at a time. */
  byInbox: (inboxIds: number[]) => Promise<Record<string, number[]>>;
  /** Which of these inboxes this campaign holds, and how many it holds in all. */
  overlap: (campaign: OpenCampaign, inboxIds: number[]) => Promise<{ on: number[]; total: number; leftConnected: number }>;
}

export interface CheckProgress {
  done: number;
  total: number;
  unit: "inbox" | "campaign";
}

/** `leftConnected`: of what would be left, how many can send. Not known (null) for a campaign keeping plenty. */
export type Overlaps = Map<number, { on: number[]; total: number; leftConnected: number | null }>;

/** Which of the selected inboxes each open campaign holds. Stops, returning null, as soon as `cancelled` says so. */
export async function checkSelection(
  inboxIds: readonly number[],
  campaigns: readonly OpenCampaign[],
  api: CheckApi,
  opts: { cancelled?: () => boolean; onProgress?: (p: CheckProgress) => void } = {},
): Promise<Overlaps | null> {
  const cancelled = opts.cancelled ?? (() => false);
  const out: Overlaps = new Map();
  const add = (campaign: OpenCampaign, on: number[], total = campaign.inboxes, leftConnected: number | null = null) => {
    if (on.length) out.set(campaign.id, { on, total, leftConnected });
  };

  if (inboxIds.length <= ASK_INBOXES_UP_TO) {
    const open = new Map(campaigns.map((c) => [c.id, c]));
    const held = new Map<number, number[]>();
    let done = 0;
    opts.onProgress?.({ done, total: inboxIds.length, unit: "inbox" });
    for (let i = 0; i < inboxIds.length; i += INBOXES_PER_ASK) {
      if (cancelled()) return null;
      const part = inboxIds.slice(i, i + INBOXES_PER_ASK);
      const answer = await api.byInbox(part);
      for (const inbox of part) {
        for (const campaignId of answer[String(inbox)] ?? []) {
          if (open.has(campaignId)) held.set(campaignId, [...(held.get(campaignId) ?? []), inbox]);
        }
      }
      done += part.length;
      opts.onProgress?.({ done, total: inboxIds.length, unit: "inbox" });
    }
    /*
     * Asking the inboxes says nothing about the rest of a campaign's list. Where few would be left it matters whether
     * they can send, so those few campaigns are read: a short list, a few reads.
     */
    for (const [id, on] of held) {
      if (cancelled()) return null;
      const campaign = open.get(id)!;
      const left = campaign.inboxes - on.length;
      if (left > 0 && left <= READ_CAMPAIGN_IF_LEFT) {
        const read = await api.overlap(campaign, on);
        add(campaign, read.on, read.total, read.leftConnected);
      } else {
        add(campaign, on);
      }
    }
    return out;
  }

  const toRead = campaigns.filter((c) => c.inboxes > 0);
  let done = 0;
  opts.onProgress?.({ done, total: toRead.length, unit: "campaign" });
  // One failed read ends the check: the other reads stop too, and say nothing more, so the failure stays on screen.
  let failed = false;
  await pooled(toRead, CAMPAIGN_READS_AT_ONCE, async (campaign) => {
    if (cancelled() || failed) return;
    try {
      const { on, total, leftConnected } = await api.overlap(campaign, [...inboxIds]);
      if (failed) return;
      add(campaign, on, total, leftConnected);
    } catch (e) {
      failed = true;
      throw e;
    }
    opts.onProgress?.({ done: ++done, total: toRead.length, unit: "campaign" });
  });
  return cancelled() ? null : out;
}

/* ------------------------------------------------------------- the plan --- */

export interface PlanRow {
  id: number;
  name: string;
  status: string;
  /** The selected inboxes on this campaign. */
  inboxIds: number[];
  /** Inboxes on it now. */
  total: number;
  /** Inboxes on it afterwards. */
  left: number;
  /** Of those, how many can send. Null when it wasn't worth reading: it keeps plenty. */
  leftConnected: number | null;
}

export interface RemovalPlan {
  /** Draft and paused: changed as they are. */
  change: PlanRow[];
  /** Active: changed only if the tick is on. */
  active: PlanRow[];
  /** Would be left with no inboxes: left exactly as they are. */
  keep: PlanRow[];
  /** Selected inboxes on no open campaign: nothing to do for them. */
  onNothing: number;
  /** The selected inboxes on at least one open campaign. */
  onSomething: number;
}

const byName = (a: PlanRow, b: PlanRow) => a.name.localeCompare(b.name);

/** What would happen to each campaign. Only campaigns holding a selected inbox are in it. */
export function planRemoval(inboxIds: readonly number[], campaigns: readonly OpenCampaign[], overlaps: Overlaps): RemovalPlan {
  const plan: RemovalPlan = { change: [], active: [], keep: [], onNothing: 0, onSomething: 0 };
  const seen = new Set<number>();
  for (const c of campaigns) {
    const found = overlaps.get(c.id);
    if (!found?.on.length) continue;
    for (const id of found.on) seen.add(id);
    const status = norm(c.status);
    const left = found.total - found.on.length;
    const row: PlanRow = { id: c.id, name: c.name, status, inboxIds: found.on, total: found.total, left, leftConnected: found.leftConnected ?? null };
    if (left < 1) plan.keep.push(row);
    else if (canChangeNow(status)) plan.change.push(row);
    else plan.active.push(row);
  }
  plan.change.sort(byName);
  plan.active.sort(byName);
  plan.keep.sort(byName);
  plan.onSomething = inboxIds.filter((id) => seen.has(id)).length;
  plan.onNothing = inboxIds.length - plan.onSomething;
  return plan;
}

/** The campaigns a run will change. */
export function runTargets(plan: RemovalPlan, includeActive: boolean): PlanRow[] {
  return includeActive ? [...plan.change, ...plan.active] : plan.change;
}

/** Campaigns that would keep inboxes, none of which can send: not empty, but it stops sending all the same. */
export function wouldStopSending(targets: readonly PlanRow[]): PlanRow[] {
  return targets.filter((t) => t.left > 0 && t.leftConnected === 0);
}

/** How many different inboxes those campaigns take off. */
export function inboxesInTargets(targets: readonly PlanRow[]): number {
  return new Set(targets.flatMap((t) => t.inboxIds)).size;
}

/* -------------------------------------------------------------- the run --- */

export type RemovalOutcome =
  /** Inboxes came off. */
  | "removed"
  /** None of them is on it any more: what was asked for is already so. */
  | "nothing"
  /** Active, and the tick was off: not touched. */
  | "active"
  /** Would have no inboxes left: not touched. */
  | "last"
  /** It has finished or been archived since the check: not touched. */
  | "finished"
  /** See `error`. Anything that did come off is in `applied`. */
  | "failed";

export interface RemovalResult {
  campaignId: number;
  ok: boolean;
  outcome: RemovalOutcome;
  /** Inboxes that came off, by the campaign's own count where it could be read. */
  applied: number;
  /** Inboxes on it before and after; null when not read. */
  before: number | null;
  left: number | null;
  /** This run paused it, so it had to be started again. */
  paused: boolean;
  /** It should be sending and isn't: starting it again failed. */
  stillPaused: boolean;
  /** Pausing it gave no clear answer, so it may be paused. Someone must look; it isn't tried again by itself. */
  unsure?: boolean;
  /** The ids sent that EmailBison took (the rest were no longer on it). */
  removedIds: number[];
  error?: string;
}

export interface RemovalDeps {
  status: (campaignId: number) => Promise<string>;
  count: (campaignId: number) => Promise<number>;
  remove: (campaignId: number, inboxIds: number[]) => Promise<unknown>;
  pause: (campaignId: number) => Promise<unknown>;
  resume: (campaignId: number) => Promise<unknown>;
  /** Called just before pausing, so a run cut short still leaves a record of it. */
  beforePause?: (campaignId: number, status: string) => Promise<unknown>;
  wait?: (ms: number) => Promise<void>;
}

const PAUSE_CHECKS = 6;
const PAUSE_CHECK_MS = 1000;
const RESUME_TRIES = 3;
const RESUME_RETRY_MS = 1500;
const RESUME_CHECKS = 4;
const RESUME_CHECK_MS = 1000;
const SETTLE_CHECKS = 20;
const SETTLE_CHECK_MS = 1000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/*
 * One call, dropping whatever EmailBison says this campaign doesn't hold and trying again: the whole call is refused
 * for one such id, and a selection can go stale between the check and this moment. Throws on any other refusal.
 */
async function removePart(deps: RemovalDeps, campaignId: number, part: number[], removed: number[]): Promise<void> {
  let ids = part;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!ids.length) return;
    try {
      await deps.remove(campaignId, ids);
      removed.push(...ids);
      return;
    } catch (e) {
      const bad = new Set(invalidIndices(e, "sender_email_ids"));
      if (!bad.size || attempt === 2) throw e;
      ids = ids.filter((_, i) => !bad.has(i));
    }
  }
}

/** Takes these inboxes off this one campaign, as far as the rules at the top allow, and says exactly what happened. */
export async function removeFromCampaign(
  deps: RemovalDeps,
  input: { campaignId: number; inboxIds: readonly number[]; pauseActive: boolean },
): Promise<RemovalResult> {
  const { campaignId, pauseActive } = input;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const inboxIds = [...new Set(input.inboxIds)];
  const result: RemovalResult = { campaignId, ok: true, outcome: "removed", applied: 0, before: null, left: null, paused: false, stillPaused: false, removedIds: [] };
  const fail = (e: unknown): RemovalResult => ({ ...result, ok: false, outcome: "failed", error: describeEmailBisonError(e) });

  let status: string;
  let before: number;
  try {
    // The status last: it decides whether this may be paused, so it is as fresh as it can be when that happens.
    before = await deps.count(campaignId);
    status = norm(await deps.status(campaignId));
  } catch (e) {
    return fail(e);
  }
  result.before = before;
  result.left = before;
  if (!isOpenStatus(status)) return { ...result, outcome: "finished" };
  const mustPause = !canChangeNow(status);
  if (mustPause && !pauseActive) return { ...result, outcome: "active" };
  if (mustPause && !canApply("pause", status)) return { ...result, outcome: "finished" };
  // If every inbox it holds might be going, it keeps them.
  if (before - inboxIds.length < 1) return { ...result, outcome: "last" };

  if (mustPause) {
    await deps.beforePause?.(campaignId, status);
    let pauseError: unknown = null;
    try {
      await deps.pause(campaignId);
    } catch (e) {
      pauseError = e;
    }
    // A refusal, or a lost answer: only the campaign itself can say which.
    let now: string | null = null;
    try {
      for (let check = 0; check < PAUSE_CHECKS; check++) {
        now = norm(await deps.status(campaignId));
        if (now === "paused" || pauseError) break;
        if (check < PAUSE_CHECKS - 1) await wait(PAUSE_CHECK_MS);
      }
    } catch {
      now = null;
    }
    if (now === "paused") {
      result.paused = true;
    } else if (pauseError && now !== null) {
      // It answered with a refusal and it isn't paused: nothing changed.
      return fail(pauseError);
    } else {
      const why = now === null ? "EmailBison gave no clear answer about pausing it" : `It didn't pause in time (it is ${now})`;
      return { ...result, ok: false, outcome: "failed", unsure: true, error: `${why}, so nothing was removed. It may still pause: check it.` };
    }
  }

  /* Until the list shows it. A count that can't be read is no reason to hold a paused campaign back: the last count says. */
  const settled = async (want: number) => {
    for (let check = 0; check < SETTLE_CHECKS; check++) {
      try {
        if ((await deps.count(campaignId)) <= want) return true;
      } catch {
        return true;
      }
      if (check < SETTLE_CHECKS - 1) await wait(SETTLE_CHECK_MS);
    }
    return false;
  };

  let refused: unknown = null;
  let wouldEmpty = false;
  let stillGoing = false;
  let toGo = inboxIds.length;
  for (const part of chunks(inboxIds, REMOVE_CHUNK)) {
    try {
      // Again before every call: someone else may be taking inboxes off it too.
      const now = await deps.count(campaignId);
      if (now - toGo < 1) {
        wouldEmpty = true;
        break;
      }
      const sentBefore = result.removedIds.length;
      await removePart(deps, campaignId, part, result.removedIds);
      toGo -= part.length;
      if (!(await settled(now - (result.removedIds.length - sentBefore)))) {
        stillGoing = true;
        break;
      }
    } catch (e) {
      refused = e;
      break;
    }
  }

  // Only what this run saw paused, and first of all: it was sending, so it goes back to sending.
  if (result.paused) {
    let resumed = false;
    for (let attempt = 0; attempt < RESUME_TRIES && !resumed; attempt++) {
      try {
        await deps.resume(campaignId);
        resumed = true;
      } catch {
        if (attempt < RESUME_TRIES - 1) await wait(RESUME_RETRY_MS);
      }
    }
    if (resumed) {
      // An answer isn't proof: if it still reads as paused after a few looks, it is reported as paused.
      try {
        for (let check = 0; check < RESUME_CHECKS; check++) {
          resumed = norm(await deps.status(campaignId)) !== "paused";
          if (resumed) break;
          if (check < RESUME_CHECKS - 1) await wait(RESUME_CHECK_MS);
        }
      } catch {
        resumed = true;
      }
    }
    result.stillPaused = !resumed;
  }

  // The campaign's own count is what really happened: a call can answer 200 and have done nothing.
  try {
    const after = await deps.count(campaignId);
    result.left = after;
    result.applied = Math.max(0, before - after);
  } catch {
    result.left = null;
    result.applied = result.removedIds.length;
  }

  if (refused) return { ...result, ok: false, outcome: "failed", error: describeEmailBisonError(refused) };
  if (result.stillPaused) return { ...result, ok: false, outcome: "failed", error: "It couldn't be started again, so it is still paused." };
  if (wouldEmpty) {
    if (!result.removedIds.length) return { ...result, outcome: "last" };
    return { ...result, ok: false, outcome: "failed", error: "Stopped part way: taking the rest off would have left it with no inboxes." };
  }
  if (!result.removedIds.length) return { ...result, outcome: "nothing" };
  if (result.left !== null && result.applied === 0) {
    return { ...result, ok: false, outcome: "failed", error: "EmailBison answered as if it had worked, but the campaign still holds every one of them." };
  }
  if (stillGoing) return { ...result, ok: false, outcome: "failed", error: "EmailBison hadn't finished taking them off when this stopped waiting. Check this campaign." };
  return result;
}
