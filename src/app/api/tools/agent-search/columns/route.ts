import { NextResponse } from "next/server";

import { ALL_COLUMNS } from "@/lib/tools/agent-search/columns";
import { scraper } from "@/lib/tools/agent-search/scraper";

/*
 * The full per-source column lists.
 *
 * Served from the ported constants when the live service cannot be reached,
 * rather than failing. The tool's own frontend does the same thing in reverse
 * — it starts from a hardcoded KEY_COLS and upgrades when /api/columns lands —
 * and the reason is the same: a table with no header is worse than a table
 * with a slightly stale one.
 *
 * `source` tells the caller which it got, so nothing has to guess.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await scraper.columns();
  if (r.ok && r.body && typeof r.body === "object" && "courted" in r.body) {
    return NextResponse.json({ ...r.body, source: "live" });
  }
  return NextResponse.json({ ...ALL_COLUMNS, source: "ported" });
}
