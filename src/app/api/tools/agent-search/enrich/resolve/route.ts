import { NextResponse, type NextRequest } from "next/server";

import { enrichCost, resolveInput } from "@/lib/tools/agent-search/sheet-source";

/*
 * Preview: how many profile URLs are in this input, and roughly what will it
 * cost — WITHOUT scraping anything.
 *
 * ---------------------------------------------------------------------------
 * REIMPLEMENTED NATIVELY, not proxied.
 *
 * This is one of only two endpoints in the whole tool whose work is pure data
 * transformation: fetch a public Google Sheet as CSV over plain HTTP, parse
 * the grid, classify each row's profile URL, count. No browser, no unblocker,
 * no Courted session, no in-memory job. So it runs here.
 *
 * The logic is `resolveInput` + `enrichCost`, copied verbatim out of the
 * tool's web/server/sheet-source.js and web/server/index.js and proven
 * identical to the originals on the same inputs (see agent-search.test.ts and
 * the differential harness noted there). The response shape below is the exact
 * shape index.js:308 returns — {total, zillow, realtor, withIdentity,
 * estCostUsd} — so the screen cannot tell the difference, and a 400 with a
 * readable message is preserved for the two failure cases the tool has: a link
 * that is not a Google Sheet, and a sheet that is not shared publicly.
 *
 * Worth stating plainly, because it is the one behavioural consequence:
 * resolving here and RUNNING on the live service means the sheet is fetched
 * twice, and if it changes in between, the preview count and the run count can
 * differ. That is already true of the tool itself — its own /api/enrich calls
 * resolveInput again rather than reusing the preview — so this is faithful, not
 * a new hazard.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    sheetUrl?: string;
    csv?: string;
    urls?: string[];
  };

  try {
    const r = await resolveInput({ sheetUrl: body.sheetUrl, csv: body.csv, urls: body.urls });
    return NextResponse.json({
      total: r.total,
      zillow: r.zillow,
      realtor: r.realtor,
      withIdentity: r.withIdentity,
      estCostUsd: enrichCost(r.total),
    });
  } catch (error) {
    // index.js answers 400 here, and the message is the whole value of the
    // response — "Sheet is not public — set sharing to Anyone with the link"
    // tells the operator exactly what to go and change.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read that input." },
      { status: 400 },
    );
  }
}
