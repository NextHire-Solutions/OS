import "server-only";

import { optionalEnv } from "@/lib/env";

import { checkGmailConnection } from "./gmail-health";
import { pollReplies } from "./gmail-replies";
import { syncBisonImports } from "./db-sync";
import { lastHealthSync, syncHealthStatuses } from "./health";
import { recordDueFollowups } from "./followup";
import { pingLostBookings } from "./booking-alerts";

/*
 * The orchestrator's background tick, in this process.
 *
 * ---------------------------------------------------------------------------
 * WHICH MECHANISM, AND WHY
 *
 * Three were on the table:
 *
 *   1. A browser-driven sweep (shell/outbox-sweeper.tsx): whoever has the OS
 *      open pings a route every two minutes. Right for the outbox, because a
 *      lost job happens on deploy, while somebody is working. Wrong here: reply
 *      polling, the daily Health Dash pull, the DB-app handshake and the
 *      follow-up clock all have to run overnight with nobody signed in.
 *
 *   2. Railway cron hitting bearer-guarded routes, with an in-process ticker
 *      as the fallback — the Analytics pattern (ENABLE_SCHEDULER=1). The OS
 *      has no cron service today.
 *
 *   3. The tool's own design: an in-process setInterval every 10 minutes
 *      (instrumentation-node.ts), same jobs in the same order.
 *
 * This is 3, matching the deployed tool, shaped like the OS's other three
 * tickers (analytics, client-health and master-inbox `ensure*Scheduler`:
 * idempotent, process-wide guard, its own ENABLE flag, unref'd timer) with 2's
 * routes kept so an external scheduler can drive the same functions later
 * (see api/tools/onboarding/cron/*). Gated by ONBOARDING_CRON_ENABLED=1 so a
 * preview deploy, a laptop or a second replica does not poll the mailbox too —
 * exactly one process should tick.
 *
 * WHERE IT STARTS. src/instrumentation.ts boots the other three tickers once
 * per Node process; this one belongs there too, and the addition is two lines:
 *
 *   const { ensureOnboardingScheduler } = await import("./lib/tools/onboarding/scheduler");
 *   ensureOnboardingScheduler();
 *
 * That file is outside this port's remit, so until it is added the ticker
 * starts LAZILY from the first request into the onboarding API (the pipeline,
 * settings, a webhook, a cron route) and then runs for the life of the
 * process. Both paths call the same idempotent `ensure`, so adding the boot
 * line later changes nothing except that a 05:59 deploy still ticks at 06:00.
 */

export const TICK_MS = 10 * 60 * 1000;
const FIRST_MS = 30_000;
const DAILY = 24 * 60 * 60 * 1000;

const g = globalThis as { __onboardingScheduler?: { startedAt: string; timer: ReturnType<typeof setInterval> } };

export function schedulerEnabled(): boolean {
  return optionalEnv("ONBOARDING_CRON_ENABLED") === "1";
}

/** Once a day is enough — the tick is every 10 minutes, so it asks first. The tool's `syncHealthStatusesIfDue`. */
export async function syncHealthStatusesIfDue(): Promise<{ ran: boolean }> {
  const last = await lastHealthSync();
  if (last && Date.now() - Date.parse(last) < DAILY) return { ran: false };
  await syncHealthStatuses();
  return { ran: true };
}

export interface TickReport {
  gmail: { ok: boolean; error?: string };
  replies?: { scanned: number; matched: number } | { error: string };
  bisonImports: { updated: number } | { error: string };
  healthStatuses: { ran: boolean } | { error: string };
  followups?: { due: number; recorded: number } | { error: string };
  lostBookings: { pinged: number } | { error: string };
}

const err = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

/** One tick, in the tool's order. Every job is isolated: one failing never stops the next. */
export async function runSchedulerTick(): Promise<TickReport> {
  const report = {} as TickReport;

  // Gmail watchdog first: alerts Slack when the mailbox token dies. While it's broken the
  // Gmail-dependent jobs are skipped — retrying them would only pile up error rows.
  let gmailOk = true;
  try {
    const h = await checkGmailConnection();
    gmailOk = h.ok;
    report.gmail = { ok: h.ok, error: h.error };
    if (!h.ok) console.error(`[onboarding:scheduler] gmail connection broken — skipping mailbox jobs (${h.error})`);
  } catch (e) { gmailOk = false; report.gmail = { ok: false, ...err(e) }; }

  if (gmailOk) {
    try { report.replies = await pollReplies(); } catch (e) { report.replies = err(e); }
  }
  try { report.bisonImports = await syncBisonImports(); } catch (e) { report.bisonImports = err(e); }
  try { report.healthStatuses = await syncHealthStatusesIfDue(); } catch (e) { report.healthStatuses = err(e); }
  if (gmailOk) {
    // The tool sends due follow-ups here; the OS records them as pending enablement.
    try { report.followups = await recordDueFollowups(); } catch (e) { report.followups = err(e); }
  }
  // The tool's email guard runs here too. Its cancel ping is kept; its sends are not.
  try { report.lostBookings = await pingLostBookings(); } catch (e) { report.lostBookings = err(e); }

  return report;
}

/** Start the ticker if it is enabled and not already running. Safe to call on every request. */
export function ensureOnboardingScheduler(): "off" | "running" | "started" {
  if (!schedulerEnabled()) return "off";
  if (g.__onboardingScheduler) return "running";
  const tick = () => {
    runSchedulerTick()
      .then((r) => console.log("[onboarding:scheduler] tick", JSON.stringify(r)))
      .catch((e) => console.error("[onboarding:scheduler] tick failed:", e));
  };
  setTimeout(tick, FIRST_MS).unref?.();
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  g.__onboardingScheduler = { startedAt: new Date().toISOString(), timer };
  console.log("[onboarding:scheduler] started — replies + bison-import sync + follow-ups + booking alerts every 10 min, health-dash statuses daily");
  return "started";
}

export function schedulerStatus(): { enabled: boolean; running: boolean; startedAt: string | null } {
  return { enabled: schedulerEnabled(), running: !!g.__onboardingScheduler, startedAt: g.__onboardingScheduler?.startedAt ?? null };
}
