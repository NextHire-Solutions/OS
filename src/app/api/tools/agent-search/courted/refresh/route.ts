import { NextResponse, type NextRequest } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/*
 * Kick the 15-day refresh once, on demand.
 *
 * Re-scrapes the most-overdue account, or a named one. Additive — re-scraping
 * adds and updates agents and MLS memberships and never deletes — so this can
 * only freshen data. It is a long sweep, not a request: the live handler
 * resolves when the whole account is done.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const r = await scraper.runRefresh(body?.email);
  return NextResponse.json(r.body, { status: r.status });
}
