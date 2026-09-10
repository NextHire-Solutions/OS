import { NextResponse, type NextRequest } from "next/server";

import { SOURCES } from "@/lib/tools/agent-search/columns";
import { scraper } from "@/lib/tools/agent-search/scraper";

/*
 * Incremental results. The caller passes how many rows it has already
 * rendered per source and gets only the rest.
 *
 * This is polling, not SSE, and deliberately: the tool has an
 * /api/search/:id/stream endpoint that its own frontend abandoned — "SSE /
 * EventSource was dropping the realtor record burst after long fetches"
 * (app.js:139). Polling is what actually works, so polling is what is ported.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const params = request.nextUrl.searchParams;
  const offsets: Record<string, number> = {};
  for (const s of SOURCES) {
    const n = Number.parseInt(params.get(s) ?? "0", 10);
    offsets[s] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  const r = await scraper.searchResults(id, offsets);
  return NextResponse.json(r.body, { status: r.status });
}
