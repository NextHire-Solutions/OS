import { NextResponse } from "next/server";

import { getCourtedState } from "@/lib/tools/agent-search/courted-state";

/*
 * The nine Courted accounts, their MLS reach, and where the 15-day refresh
 * rotation has got to. Read natively from Agent Search's own Supabase — see
 * courted-state.ts for why the tool collects this and never shows it.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getCourtedState());
}
