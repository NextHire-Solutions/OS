import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/workspace";
import { liveSendingEnabled, LIVE_SEND_ENV_VAR } from "@/lib/tools/master-inbox/ai/live-gate";
import { releaseHeldReplies } from "@/lib/tools/master-inbox/ai/release";
import { LIVE_TRANSPORT_WIRED } from "@/lib/tools/master-inbox/ai/send-transport";
import { loadHeldStates } from "@/lib/tools/master-inbox/ai/thread-state";

/*
 * The off-hours release sweep — plan §5's "background job [that] releases the
 * held replies when the window opens".
 *
 *   GET  what is waiting, and whether anything could be sent if it were due
 *   POST run the sweep
 *
 * ---------------------------------------------------------------------------
 * HOW THIS GETS CALLED
 *
 * It does not call itself. Two existing mechanisms in this workspace can drive
 * it, and both are a deliberate step somebody else has to take:
 *
 *   · the in-process scheduler, lib/tools/master-inbox/sync/scheduler.ts — one
 *     entry in its JOBS map and one line in sync/cron.ts's SCHEDULE. That file
 *     belongs to work in flight and is not edited from here.
 *
 *   · the browser-driven sweep, components/shell/outbox-sweeper.tsx, which
 *     already POSTs every two minutes while anyone has the workspace open.
 *
 * Until one of them is wired, held replies stay held and this endpoint is the
 * manual handle. That is a safe failure: holding is what the whole gate does.
 *
 * ---------------------------------------------------------------------------
 * SAFE TO CALL AT ANY TIME
 *
 * A release is a full send attempt — every safety check re-run from scratch on
 * a reply that may be hours old (see ai/release.ts). Today every one of them
 * stops at the live gate, so this endpoint reports what WOULD be attempted and
 * sends nothing.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const session = await requireSession();
  const held = await loadHeldStates(session.activeWorkspace.id, 200);
  return NextResponse.json({
    held: held.length,
    live_sending_enabled: liveSendingEnabled(),
    transport_wired: LIVE_TRANSPORT_WIRED,
    env_var: LIVE_SEND_ENV_VAR,
    oldest_held_at: held[0]?.heldAt ?? null,
    by_reason: held.reduce<Record<string, number>>((acc, s) => {
      const key = s.holdReason ?? "unknown";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  });
}

export async function POST() {
  const session = await requireSession();
  const report = await releaseHeldReplies(session.activeWorkspace.id, new Date());
  return NextResponse.json({
    ...report,
    live_sending_enabled: liveSendingEnabled(),
    transport_wired: LIVE_TRANSPORT_WIRED,
  });
}
