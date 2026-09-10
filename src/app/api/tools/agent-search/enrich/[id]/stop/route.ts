import { NextResponse } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const r = await scraper.stopEnrich(id);
  return NextResponse.json(r.body, { status: r.status });
}
