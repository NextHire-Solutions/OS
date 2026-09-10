import { NextResponse } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/*
 * The de-duplicated master list for a job.
 *
 * Proxied rather than computed here, because the ROWS live in the live
 * service's memory — buildMaster needs all three sources' scraped rows, and
 * the workspace never holds them. The identical algorithm is ported to
 * lib/tools/agent-search/merge.ts and tested there, so what this returns is
 * verifiable rather than merely trusted.
 *
 * Given a long timeout: merging a large sweep is Union-Find over every scraped
 * row and is not instant.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const r = await scraper.master(id);
  return NextResponse.json(r.body, { status: r.status });
}
