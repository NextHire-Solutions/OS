import { NextResponse } from "next/server";

import { getAgentSearchOverview } from "@/lib/tools/agent-search/agents";

/*
 * Agent Search's headline counts and saved lists.
 *
 * Read-only. The four scraping workers and the MLS monitor keep running on the
 * live service; the workspace reads what they produce.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getAgentSearchOverview());
}
