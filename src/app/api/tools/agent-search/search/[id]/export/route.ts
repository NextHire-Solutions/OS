import { type NextRequest } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/*
 * CSV download — one source, or `source=master` for the merged list.
 *
 * Streamed straight through, keeping the upstream Content-Disposition so the
 * file saves under the name the tool chose, and keeping its bytes so the
 * UTF-8 BOM survives. Re-encoding here would drop the BOM and Excel would
 * render every accented name as mojibake.
 */
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["courted", "zillow", "realtor", "master"]);

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const asked = request.nextUrl.searchParams.get("source") ?? "courted";
  // Matches the tool's own fallback (index.js:481) rather than erroring.
  const source = ALLOWED.has(asked) ? asked : "courted";
  return scraper.exportCsv(id, source);
}
