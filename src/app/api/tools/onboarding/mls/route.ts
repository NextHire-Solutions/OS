import { NextResponse } from "next/server";

import { searchMls } from "@/lib/tools/onboarding/client-leads";

/*
 * Type-ahead for the MLS picker on a client.
 *
 * Reads Agent Search's `mls` table, which Onboarding may read and may never
 * write — `lib/tools/onboarding/db.ts` throws before the network call on any
 * write outside `orch_*`.
 *
 * The picker exists instead of a text box for one reason: an MLS code that
 * matches nothing resolves to no MLS, and the lead build would then produce an
 * empty list without complaining.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  // Under two characters the tool returns nothing rather than the whole table.
  return NextResponse.json({ options: await searchMls(q) });
}
