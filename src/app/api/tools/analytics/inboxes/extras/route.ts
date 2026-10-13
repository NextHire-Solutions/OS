import { NextResponse } from "next/server";

import { inboxExtras } from "@/lib/tools/analytics/inbox-extras-load";

/*
 * Warmup scores and exact campaign assignment for the Inboxes page (13 Oct).
 *
 * Separate from the list itself because it comes from EmailBison, takes a few
 * minutes the first time, and must not hold up 1,700 rows that are ready now.
 * This answers at once with whatever is known — "loading" included — and the
 * page asks again until it is "ready". See inbox-extras-load.ts.
 *
 * Read-only. Never cached here: the answer changes while the read runs.
 */

export const dynamic = "force-dynamic";

export function GET() {
  try {
    return NextResponse.json(inboxExtras(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // A missing setting (the EmailBison key, the database) — named, not a bare 500.
    return NextResponse.json(
      { status: "error", extras: null, progress: null, error: e instanceof Error ? e.message : "Could not start" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
