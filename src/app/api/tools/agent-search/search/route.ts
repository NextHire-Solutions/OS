import { NextResponse, type NextRequest } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/*
 * Start a scrape.
 *
 * The body is passed through untouched. Every default and clamp lives in the
 * tool's own handler (index.js:367) — courtedMax, courtedBanded, the 25-page
 * Zillow cap, the source whitelist — and re-deriving them here would create a
 * second set of defaults to keep in sync with the first. The tool is the
 * authority on what a search means.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const r = await scraper.startSearch(body);
  return NextResponse.json(r.body, { status: r.status });
}
