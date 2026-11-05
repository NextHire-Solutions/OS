import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";

import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";
import { campaignOverlap } from "@/lib/tools/analytics/campaign-inboxes-load";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors.ts";

/*
 * Which of the selected inboxes one campaign holds (5 Nov — inbox-removal.ts). A POST only because the ids don't fit in
 * an address. Read-only: up to 150 GETs the first time, none while its list is kept.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Body = z.object({
  campaignId: z.number().int().positive(),
  count: z.number().int().min(0),
  inboxIds: z.array(z.number().int().positive()).min(1).max(10_000),
});

export async function POST(request: NextRequest) {
  const store = await cookies();
  const session = await verifySessionToken(process.env.AUTH_SECRET ?? "", store.get(AUTH_COOKIE)?.value);
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const { campaignId, count, inboxIds } = parsed.data;
    return NextResponse.json(await campaignOverlap(campaignId, count, inboxIds), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/campaigns/inboxes/removal/overlap]", e);
    return NextResponse.json({ error: describeEmailBisonError(e) }, { status: 502 });
  }
}
