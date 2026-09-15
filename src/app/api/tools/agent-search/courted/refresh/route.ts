import { NextResponse, type NextRequest } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/*
 * Kick the 15-day refresh once, on demand.
 *
 * Re-scrapes the most-overdue account, or a named one. Additive — re-scraping
 * adds and updates agents and MLS memberships and never deletes — so this can
 * only freshen data. It is a long sweep, not a request: the live handler
 * resolves when the whole account is done, hours later.
 *
 * So this is fire-and-poll (scraper.fireScraper). An early refusal from the
 * live service — no accounts, already running, no such account — comes back
 * as-is; otherwise the answer is 202 `{ started: true }` and the screen
 * watches GET courted-state for that account's `lastRefreshedAt` to move.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const r = await scraper.runRefresh(body?.email);
  return NextResponse.json(r.body, { status: r.status });
}
