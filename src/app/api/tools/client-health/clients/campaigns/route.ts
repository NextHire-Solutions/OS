import { NextResponse, type NextRequest } from "next/server";

import { requireSession } from "@/lib/auth/workspace";
import { applyToggle, planToggle, type ToggleAction } from "@/lib/tools/client-health/campaign-toggle";
import { getWeekly } from "@/lib/tools/client-health/weekly";

/*
 * Play/Pause all of one client's campaigns — the tool's /api/clients/campaigns.
 *
 *   GET  ?clientId=…&action=pause|resume   preview: live statuses, what would
 *                                          change and what would be skipped.
 *                                          Sends nothing to any platform.
 *   POST { clientId, action }              apply. Re-plans from live statuses.
 *
 * Both need a signed-in person. This path is NOT in the proxy's TOKEN_ROUTES,
 * so the read-only x-admin-token never reaches it; the check below refuses the
 * header anyway, because even the preview reveals campaign state and a token
 * handed to readers must never be able to stop or start sending.
 */
export const dynamic = "force-dynamic";

function parseAction(v: unknown): ToggleAction | null {
  return v === "pause" || v === "resume" ? v : null;
}

async function signedIn(request: NextRequest): Promise<string | NextResponse> {
  if (request.headers.has("x-admin-token")) {
    return NextResponse.json({ error: "Play/Pause needs a signed-in team member" }, { status: 403 });
  }
  const email = (await requireSession()).user.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return email;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const who = await signedIn(request);
  if (who instanceof NextResponse) return who;
  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");
  const action = parseAction(url.searchParams.get("action"));
  if (!clientId || !action) {
    return NextResponse.json({ error: "clientId and action=pause|resume required" }, { status: 400 });
  }
  try {
    return NextResponse.json({ plan: await planToggle(clientId, action) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const who = await signedIn(request);
  if (who instanceof NextResponse) return who;
  const body = (await request.json().catch(() => ({}))) as { clientId?: string; action?: unknown };
  const action = parseAction(body.action);
  if (!body.clientId || !action) {
    return NextResponse.json({ error: "clientId and action=pause|resume required" }, { status: 400 });
  }
  try {
    const result = await applyToggle(body.clientId, action, who);
    // The held list and the campaign statuses just changed; the 60-second
    // screen cache must not serve the old ones.
    getWeekly.invalidate();
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
