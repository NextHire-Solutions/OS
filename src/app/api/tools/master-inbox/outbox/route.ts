import { NextResponse } from "next/server";

import { drain, outboxHealth } from "@/lib/tools/master-inbox/outbox";
import { ensureCronScheduler } from "@/lib/tools/master-inbox/sync/scheduler";

/*
 * The introduction outbox: what is waiting, and a retry.
 *
 * GET  reports pending and failed counts, plus how old the oldest waiting job
 *      is — the number that says whether the sweep is keeping up.
 * POST retries whatever was left behind by a lost process.
 *
 * The sweep is safe to call often: it claims a batch before working it, so two
 * overlapping runs cannot both send the same Slack notice, and a claim older
 * than five minutes is treated as abandoned.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  return NextResponse.json(await outboxHealth());
}

export async function POST() {
  /*
   * The browser drives this sweep every two minutes while anyone has the
   * workspace open — which makes it the one request this process is sure to
   * keep receiving. Master Inbox's in-process cron piggybacks on that: a
   * no-op unless MASTER_INBOX_CRON_ENABLED=1, see sync/scheduler.ts.
   */
  ensureCronScheduler();
  return NextResponse.json(await drain());
}
