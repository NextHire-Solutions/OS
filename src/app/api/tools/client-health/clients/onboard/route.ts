import { NextResponse, type NextRequest } from "next/server";

import { onboardClient } from "@/lib/tools/client-health/onboard";
import { getSupabase } from "@/lib/tools/client-health/supabase";
import { getWeekly } from "@/lib/tools/client-health/weekly";

/*
 * Inbound client onboarding — the tool's POST /api/clients/onboard, served by
 * the workspace.
 *
 * Auth: shared secret in `x-admin-token`, checked against
 * CLIENT_HEALTH_ONBOARDING_TOKEN (the tool's ONBOARDING_TOKEN, namespaced). If
 * the variable is unset the endpoint refuses every request — 500 rather than
 * accidentally exposing an open create endpoint. Same rule as the tool.
 *
 * Note that the workspace's front door (src/proxy.ts) sits in front of this
 * route and asks for a signed-in session first. An outside system calling
 * with only the token reaches this handler only if the proxy lets a
 * token-bearing POST to this path through; the OS's own onboarding run does
 * not go over HTTP at all — it calls `onboardClient` in-process.
 *
 * The logic lives in lib/tools/client-health/onboard.ts so both callers share
 * one validation path.
 */
export const dynamic = "force-dynamic";

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CLIENT_HEALTH_ONBOARDING_TOKEN?.trim();
  if (!secret) return bad("server misconfigured: CLIENT_HEALTH_ONBOARDING_TOKEN not set", 500);
  if (request.headers.get("x-admin-token") !== secret) return bad("unauthorized", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON body");
  }

  let db: ReturnType<typeof getSupabase>;
  try {
    db = getSupabase();
  } catch (error) {
    return bad(error instanceof Error ? error.message : "Client Health is not configured", 501);
  }

  try {
    const result = await onboardClient(db, body);
    if (!result.ok) {
      const { ok: _ok, status, ...rest } = result;
      return NextResponse.json(rest, { status });
    }
    // The 60-second read cache predates this row; drop it, as every write does.
    getWeekly.invalidate();
    return NextResponse.json(result.value, { status: 201 });
  } catch (error) {
    console.error("[api/tools/client-health/clients/onboard]", error);
    return bad(error instanceof Error ? error.message : "The write could not be completed", 502);
  }
}
