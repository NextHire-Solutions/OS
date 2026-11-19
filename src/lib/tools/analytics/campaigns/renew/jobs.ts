import { randomUUID } from "node:crypto";

import { runRenew, type RenewIO, type RenewResult, type RenewStage } from "./renew.ts";

/*
 * Duplicate & Renew runs as a JOB in the server, not inside the request.
 *
 * A renewal reads every lead twice, moves thousands and waits for EmailBison to
 * finish the move: minutes on a big campaign. Inside one request a closed tab or
 * a proxy timeout would abandon it half-way with nobody told. As a job it runs
 * to the end whatever the browser does; the review window polls it, and every
 * run leaves "started" and "finished" rows in the campaign audit log.
 *
 * One job per campaign at a time. Kept in this process (one OS server) under a
 * global key, because Next builds a route module more than once (cache/ttl.ts
 * `shared`). Finished jobs are forgotten after an hour; the audit log keeps them
 * (and the review reads it, so a run cut short by a restart is never repeated
 * blindly — renew.ts).
 *
 * THE CLIENT PIN FOLLOWS LATER. A campaign whose client was pinned by hand
 * passes the pin on, but the new campaign has no client row
 * until the analytics sync lists it (every 30 minutes). The job keeps trying
 * every 2 minutes for an hour after the run, and says when it is done.
 */

export interface RenewJob {
  id: string;
  sourceId: number;
  actor: string;
  startedAt: number;
  finishedAt: number | null;
  stage: RenewStage;
  log: string[];
  result: RenewResult | null;
}

const KEY = Symbol.for("os.analytics.renewJobs");
const KEEP_MS = 60 * 60_000;

function store(): Map<string, RenewJob> {
  const g = globalThis as unknown as Record<symbol, Map<string, RenewJob> | undefined>;
  return (g[KEY] ??= new Map());
}

function prune(now: number) {
  for (const [id, job] of store()) if (job.finishedAt && now - job.finishedAt > KEEP_MS) store().delete(id);
}

export function runningFor(sourceId: number): RenewJob | null {
  for (const job of store().values()) if (job.sourceId === sourceId && !job.finishedAt) return job;
  return null;
}

export function getJob(id: string): RenewJob | null {
  return store().get(id) ?? null;
}

/** Starts a renewal, or answers with the one already running for this campaign. */
export interface JobOptions {
  /** How often a pending client setting is tried again, and for how long. */
  pinEveryMs?: number;
  pinForMs?: number;
  /** setTimeout, injectable for tests. */
  later?: (fn: () => void, ms: number) => void;
}

function followPin(job: RenewJob, io: RenewIO, options: JobOptions) {
  const r = job.result;
  if (!r?.ok || !r.pinPending || !r.newCampaignId) return;
  const every = options.pinEveryMs ?? 2 * 60_000;
  const until = Date.now() + (options.pinForMs ?? 60 * 60_000);
  const later = options.later ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const pin = r.pinPending;
  const newId = r.newCampaignId;
  const attempt = async () => {
    let done = false;
    try { done = await io.applyClientPin(newId, pin, job.sourceId); } catch { done = false; }
    if (done) {
      r.pinPending = null;
      job.log.push("The new campaign now has the old one's client setting.");
    } else if (Date.now() + every > until) {
      job.log.push("The new campaign's client setting could not be applied within an hour (it is not synced yet): set it on its Clients row by hand.");
    } else {
      later(() => void attempt(), every);
    }
  };
  later(() => void attempt(), every);
}

export function startRenewJob(sourceId: number, token: string, poolIds: readonly number[], actor: string, io: RenewIO, options: JobOptions = {}): { job: RenewJob; started: boolean } {
  const now = Date.now();
  prune(now);
  const running = runningFor(sourceId);
  if (running) return { job: running, started: false };
  const job: RenewJob = { id: randomUUID(), sourceId, actor, startedAt: now, finishedAt: null, stage: "checking", log: [], result: null };
  store().set(job.id, job);
  void runRenew(sourceId, token, poolIds, actor, io, (stage, line) => {
    job.stage = stage;
    job.log.push(line);
  })
    .then((result) => {
      job.result = result;
      followPin(job, io, options);
    })
    .catch((e) => {
      job.result = {
        ok: false, stage: job.stage, sourceId, oldName: "", numberedName: null, newCampaignId: null, newName: null, rolledBack: false,
        inboxesAdded: 0, pool: { asked: poolIds.length, added: 0, dropped: [] }, tags: [],
        leads: { planned: { move: 0, copy: 0 }, copied: 0, moved: 0, copyRefused: 0, notArrived: [], lost: [], skippedAtMove: 0, busy: 0 },
        pinPending: null, links: null, oldRenamed: false, warnings: [],
        error: `The renewal stopped unexpectedly: ${e instanceof Error ? e.message : String(e)}. Open Duplicate & Renew again before retrying: it shows whether a copy was made.`,
      };
    })
    .finally(() => { job.finishedAt = Date.now(); });
  return { job, started: true };
}
