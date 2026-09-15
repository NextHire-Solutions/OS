import { NextResponse } from "next/server";
import { syncHealth } from "@/lib/tools/analytics/sync/health";
import { ensureScheduler } from "@/lib/tools/analytics/sync/scheduler";

/*
 * Sync health for the dashboard, behind the normal session auth.
 *
 * The computation lives in lib/sync/health.ts — one implementation, read by
 * the screen's staleness strip. It reads the same sync_state / sync_runs rows
 * the in-process runner writes, so what it reports is what this process did.
 *
 * This is also where the in-process scheduler gets its first chance to start:
 * the analytics screen polls this route, so the ticker is up from the first
 * page view after a deploy. A src/instrumentation.ts hook would start it at
 * boot instead; the port report says how.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const scheduler = ensureScheduler();
  return NextResponse.json({ ...(await syncHealth()), scheduler });
}
