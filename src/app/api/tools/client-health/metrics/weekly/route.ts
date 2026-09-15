import { NextResponse, type NextRequest } from "next/server";

import { checkReadToken, weeklyMetrics } from "@/lib/tools/client-health/publish";
import { getSupabase } from "@/lib/tools/client-health/supabase";

/*
 * Weekly metrics, for other systems to read — the tool's GET
 * /api/metrics/weekly (commit e373ff4).
 *
 * The numbers people argue about most — emails sent, introductions per week —
 * were computed inside the tool and rendered straight into its dashboard, so
 * no other tool could check its own figures against them. This publishes
 * weekly_metrics with client names attached, and states `week_starts_on:
 * "monday"` rather than assuming every consumer buckets the same way.
 *
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (Monday week_keys), or ?weeks=N
 * (default 13, max 26) when no range is given.
 *
 * Auth: `x-admin-token` against CLIENT_HEALTH_READ_TOKEN. Unset → 500.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = checkReadToken(request.headers.get("x-admin-token"));
  if (auth === "unconfigured") {
    return NextResponse.json({ error: "server misconfigured: CLIENT_HEALTH_READ_TOKEN not set" }, { status: 500 });
  }
  if (auth === "denied") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    getSupabase();
    const q = request.nextUrl.searchParams;
    const result = await weeklyMetrics({ from: q.get("from"), to: q.get("to"), weeks: q.get("weeks") });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.value);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client Health is unreachable" },
      { status: 500 },
    );
  }
}
