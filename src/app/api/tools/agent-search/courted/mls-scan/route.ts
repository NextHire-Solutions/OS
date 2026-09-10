import { NextResponse } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/** Start a background scan of every configured account's MLS list. */
export const dynamic = "force-dynamic";

export async function POST() {
  const r = await scraper.startMlsScan();
  return NextResponse.json(r.body, { status: r.status });
}
