import "server-only";

import { attachHealth, healthRows, type AttachHealth } from "./attach-health.ts";
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
    if (bounces === "missing") return { ok: false, error: "The inbox health check isn't switched on (analytics 098), so no inbox can be checked. Nothing was added." };
    return { ok: true, health: attachHealth(asked, inboxes, healthRows(asked, bounces, warm)) };
  } catch (e) {
    return { ok: false, error: `The inboxes' health couldn't be checked just now, so nothing was added. Try again in a minute. (${(e instanceof Error ? e.message : String(e)).slice(0, 160)})` };
  }
}
