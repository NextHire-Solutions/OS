import { NextResponse } from "next/server";

import { getWeekly } from "@/lib/tools/client-health/weekly";

/*
 * Client Health's data, for the three screens that show it.
 *
 * It exists so those screens can load their own data instead of every page in
 * the workspace carrying it. That one change is worth 722 KB on every route —
 * see `loadClientHealth()` in the client for the measurement and the reasoning.
 *
 * The proxy has already checked the session; an unauthenticated request never
 * reaches this handler.
 *
 * The read is deliberately uncached at the framework level. Client Health's
 * sync worker writes continuously, and a stale "intros this week" is the one
 * number on the screen somebody might act on.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getWeekly());
  } catch (error) {
    console.error("[api/tools/client-health]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client Health is unreachable" },
      { status: 502 },
    );
  }
}
