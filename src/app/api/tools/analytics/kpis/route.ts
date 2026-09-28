import { NextResponse, type NextRequest } from "next/server";
import { loadKpis } from "@/lib/tools/analytics/kpis";
import { resolveFilters, toISODate } from "@/lib/tools/analytics/query-params.ts";
import { analyticsTeamId } from "@/lib/tools/analytics/supabase";
import { cachedGet } from "@/lib/tools/analytics/cached-get";

// A filter change always hits the RPC: the cache (cached-get.ts) is keyed by
// every query parameter, so only an identical question is answered from memory.
export const dynamic = "force-dynamic";

async function load(request: NextRequest) {
  const teamId = analyticsTeamId();

  let filters;
  try {
    // The SAME parser the client hook uses, so the two can't disagree about
    // what "7d" means or whether `to` is inclusive.
    filters = resolveFilters(
      request.nextUrl.searchParams,
      toISODate(new Date()),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filters" },
      { status: 400 },
    );
  }

  try {
    const data = await loadKpis(filters, teamId);
    return NextResponse.json({ ...data, range: { from: filters.from, to: filters.to } });
  } catch (error) {
    console.error("[api/analytics/kpis]", error);
    return NextResponse.json(
      { error: "Failed to load metrics" },
      { status: 500 },
    );
  }
}

// Identical questions inside a minute are answered from memory — see cached-get.ts.
export const GET = cachedGet(load);
