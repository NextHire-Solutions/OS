import { NextResponse } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/*
 * What the live service has configured: whether any Courted account is
 * loaded, how many, and which unblocker is active.
 *
 * The Add-account flow polls this through a Railway redeploy waiting for the
 * account count to rise, so it must never be cached — a stale 200 would end
 * the wait early and start a sweep on a container that is about to restart.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await scraper.status();
  return NextResponse.json(r.body, { status: r.status });
}
