import { NextResponse, type NextRequest } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/** Poll an enrichment job: progress, counters, and only the rows not yet seen. */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const n = Number.parseInt(request.nextUrl.searchParams.get("offset") ?? "0", 10);
  const r = await scraper.enrichJob(id, Number.isFinite(n) && n > 0 ? n : 0);
  return NextResponse.json(r.body, { status: r.status });
}
