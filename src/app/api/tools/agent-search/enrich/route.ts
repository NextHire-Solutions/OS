import { NextResponse, type NextRequest } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/*
 * Start an enrichment run over a sheet / CSV / URL list.
 *
 * Spends real money (Bright Data, ~$1.50 per 1,000 fetches) and writes new
 * agents through the ingest webhook, so it is insert-only: the reconcile pass
 * inside the service skips anything already in `agents` by email or phone, and
 * existing rows are never modified.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const r = await scraper.startEnrich(body);
  return NextResponse.json(r.body, { status: r.status });
}
