import { NextResponse } from "next/server";

import { cycleProgress } from "@/lib/tools/client-health/cycle-pause";

/*
 * GET /api/tools/client-health/cycle-pauses: every client's billing cycle as Intros / Billing shows it, and what the
 * billing-cycle pause did this cycle or would do (cycle-pause.ts). Reads only. Under Client Health's path, so the
 * proxy opens it only to people with Client Health: Campaign Management shows the progress to them and nobody else.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await cycleProgress());
  } catch (error) {
    console.error("[api/tools/client-health/cycle-pauses]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Client Health is unreachable" }, { status: 502 });
  }
}
