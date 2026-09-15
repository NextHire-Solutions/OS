import { NextResponse, type NextRequest } from "next/server";

import { checkReadToken, clientStatuses } from "@/lib/tools/client-health/publish";
import { getSupabase } from "@/lib/tools/client-health/supabase";

/*
 * Read-only client-status listing — the tool's GET /api/clients/status.
 *
 * Every client, as id + name + active | paused | churned, with counts. For
 * external systems that need a roster snapshot without the whole profile.
 *
 * Auth: `x-admin-token` against CLIENT_HEALTH_READ_TOKEN (the tool's
 * READ_ONLY_TOKEN). Unset → 500, never open. Exactly the tool's rule, so a
 * consumer that already reads the tool's endpoint can move to this one with
 * its token and its error handling unchanged.
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
    return NextResponse.json(await clientStatuses());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client Health is unreachable" },
      { status: 500 },
    );
  }
}
