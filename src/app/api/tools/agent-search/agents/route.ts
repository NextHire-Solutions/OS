import { NextResponse, type NextRequest } from "next/server";

import { parseAgentQuery, searchAgents } from "@/lib/tools/agent-search/agents";

/*
 * One page of agents.
 *
 * The table holds 1.17 million rows, so paging is not an optimisation here —
 * it is the only way to query it at all. The page size is fixed server-side
 * rather than taken from the caller: this route is reachable by anyone signed
 * in to the workspace, and `&limit=100000` in an address bar should not be
 * able to pull the table.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const query = parseAgentQuery(request.nextUrl.searchParams);
  return NextResponse.json(await searchAgents(query));
}
