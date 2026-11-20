import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";

import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";
import { healthView } from "@/lib/tools/analytics/campaigns/attach-health.ts";
import { readAttachHealth } from "@/lib/tools/analytics/campaigns/attach-health-io";

/*
 * POST { inboxIds } — which of these inboxes the health rules let onto a campaign, and why the rest are left out
 * (attach-health.ts). Reads only: the Add to campaigns window shows it before anything is pressed. The add itself
 * (../run) judges again and sends only the healthy ones, whatever the window was shown.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Body = z.object({ inboxIds: z.array(z.number().int().positive()).max(10_000) });

export async function POST(request: NextRequest) {
  const store = await cookies();
  const session = await verifySessionToken(process.env.AUTH_SECRET ?? "", store.get(AUTH_COOKIE)?.value);
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const r = await readAttachHealth(parsed.data.inboxIds);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 503, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(healthView(r.health), { headers: { "Cache-Control": "no-store" } });
}
