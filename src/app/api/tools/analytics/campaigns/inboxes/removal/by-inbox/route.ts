import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";

import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";
import { createEmailBisonClient, EmailBisonApiError } from "@/lib/tools/analytics/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors.ts";
import { INBOXES_PER_ASK } from "@/lib/tools/analytics/campaigns/inbox-removal.ts";
import { pooled } from "@/lib/tools/analytics/inbox-extras.ts";

/*
 * Every campaign each of a few inboxes is on (5 Nov — inbox-removal.ts). The cheap way round for a small selection:
 * about 20 GETs an inbox, against thousands to read every campaign. Read-only.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Body = z.object({ inboxIds: z.array(z.number().int().positive()).min(1).max(INBOXES_PER_ASK) });

export async function POST(request: NextRequest) {
  const store = await cookies();
  const session = await verifySessionToken(process.env.AUTH_SECRET ?? "", store.get(AUTH_COOKIE)?.value);
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const eb = createEmailBisonClient();
    const lists = await pooled(parsed.data.inboxIds, INBOXES_PER_ASK, async (id): Promise<[string, number[]]> => {
      try {
        return [String(id), (await eb.getSenderEmailCampaigns(id)).map((c) => Number(c.id))];
      } catch (e) {
        // Deleted since the page loaded: it is on no campaign.
        if (e instanceof EmailBisonApiError && e.statusCode === 404) return [String(id), []];
        throw e;
      }
    });
    return NextResponse.json({ campaigns: Object.fromEntries(lists) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/campaigns/inboxes/removal/by-inbox]", e);
    return NextResponse.json({ error: describeEmailBisonError(e) }, { status: 502 });
  }
}
