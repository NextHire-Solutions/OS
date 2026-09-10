import { NextResponse, type NextRequest } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/*
 * Detect which MLSs a Courted login can see, with an exact agent count each.
 *
 * Read-only against Courted and nothing is saved — it exists so the operator
 * can choose "whole account" or a subset before committing to a sweep that may
 * run for hours. Slow by nature: it logs in, samples ordered pages to
 * enumerate the codes, then probes a server-side count per code.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const r = await scraper.mlsList(body);
  return NextResponse.json(r.body, { status: r.status });
}
