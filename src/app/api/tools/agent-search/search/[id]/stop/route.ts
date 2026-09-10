import { NextResponse } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/** Abort a running scrape. Rows already captured are kept — the tool's abort
 *  is cooperative, and everything flushed to the DB stays there. */
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const r = await scraper.stopSearch(id);
  return NextResponse.json(r.body, { status: r.status });
}
