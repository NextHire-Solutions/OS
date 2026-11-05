import { NextResponse } from "next/server";

import { activeCapacity } from "@/lib/tools/analytics/campaign-inboxes-load";

/*
 * The inboxes on active campaigns and their daily volume, for the Campaigns page (5 Nov — campaign-inboxes-load.ts).
 *
 * Its own route because it comes from EmailBison and takes a minute or two the first time: the list of campaigns
 * mustn't wait for it. Answers at once with whatever is known, and the page asks again until it is ready.
 *
 * Read-only.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await activeCapacity(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { status: "error", active: null, asOf: null, progress: null, error: e instanceof Error ? e.message : "Could not read the active inboxes" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
