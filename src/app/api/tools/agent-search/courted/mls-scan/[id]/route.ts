import { NextResponse } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/** Poll a scan — returns per-account MLS lists as each account completes. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const r = await scraper.mlsScan(id);
  return NextResponse.json(r.body, { status: r.status });
}
