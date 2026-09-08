import { NextResponse } from "next/server";

import { getPerformance } from "@/lib/workspace/performance";

/*
 * Data for one screen, so the other screens do not pay for it.
 *
 * Every route used to load every screen's data — around eleven upstream calls
 * between them — which is why time to first byte was one to two and a half
 * seconds on pages carrying no data of their own. See `Lazy` for the whole
 * reasoning.
 *
 * The proxy has already verified the session; an unauthenticated request never
 * reaches this handler.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getPerformance());
  } catch (error) {
    console.error("[api/workspace/performance]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load performance" },
      { status: 502 },
    );
  }
}
