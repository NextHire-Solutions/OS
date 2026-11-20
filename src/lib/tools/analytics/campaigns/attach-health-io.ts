import "server-only";

import { attachHealth, healthRows, leftOutWords, type AttachHealth } from "./attach-health.ts";
import { inboxesById, recentBounces, warmupScores } from "./health-reads.ts";

/*
 * The inbox health rules applied to ids about to go onto a campaign (attach-health.ts). Refuses rather than guesses:
 * if the bounces (analytics 098) or the warm-up scores can't be read, nothing is judged healthy and the caller adds
 * nothing, saying why.
 */

export type AttachHealthRead = { ok: true; health: AttachHealth } | { ok: false; error: string };

export interface AttachHealthReads {
  inboxes: typeof inboxesById;
  bounces: typeof recentBounces;
  warmup: () => Promise<Map<number, { score: number | null; sent: number }>>;
}

const REAL: AttachHealthReads = { inboxes: inboxesById, bounces: recentBounces, warmup: () => warmupScores() };

export async function readAttachHealth(ids: readonly number[], reads: AttachHealthReads = REAL): Promise<AttachHealthRead> {
  const asked = [...new Set(ids)];
  if (!asked.length) return { ok: true, health: attachHealth([], [], []) };
  try {
    const [inboxes, bounces, warm] = await Promise.all([reads.inboxes(asked), reads.bounces(asked), reads.warmup()]);
    if (bounces === "missing") return { ok: false, error: "The inbox health check isn't switched on (analytics 098), so no inbox can be checked, and none goes onto a campaign until it can." };
    return { ok: true, health: attachHealth(asked, inboxes, healthRows(asked, bounces, warm)) };
  } catch (e) {
    return { ok: false, error: `The inboxes' health couldn't be checked just now, so none goes onto a campaign. Try again in a minute. (${(e instanceof Error ? e.message : String(e)).slice(0, 160)})` };
  }
}

/** What an attach path keeps: the healthy ids, and a line saying what was left out and why (or why none could go on). */
export interface HealthyOnly {
  ids: number[];
  leftOut: number;
  /** True when the health couldn't be read, so none went on. */
  unchecked: boolean;
  note: string | null;
}

/*
 * Every other way inboxes are copied onto a campaign (20 Nov, the team: "apply the same inbox health requirements
 * across all campaign operations ... only healthy inboxes are assigned, regardless of how the campaign is created"):
 * duplicating to other markets, Re-campaign, a new client's first campaign, the onboarding connector. The campaign is
 * still made; only its inboxes are filtered. Unreadable health: none go on, and the note says to add them with Assign.
 */
export async function healthyOnly(ids: readonly number[], read: (ids: readonly number[]) => Promise<AttachHealthRead> = readAttachHealth): Promise<HealthyOnly> {
  const asked = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!asked.length) return { ids: [], leftOut: 0, unchecked: false, note: null };
  const r = await read(asked);
  if (!r.ok) return { ids: [], leftOut: asked.length, unchecked: true, note: `No inboxes added: ${r.error} Add them with Assign once it can.` };
  const leftOut = asked.length - r.health.healthy.length;
  const why = leftOutWords(r.health.counts);
  return {
    ids: r.health.healthy,
    leftOut,
    unchecked: false,
    note: leftOut ? `${leftOut.toLocaleString("en-US")} ${leftOut === 1 ? "inbox" : "inboxes"} left out by the health rules${why ? `: ${why}` : ""}.` : null,
  };
}
