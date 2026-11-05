import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors.ts";
import { isOpenStatus, type OpenCampaign } from "@/lib/tools/analytics/campaigns/inbox-removal.ts";
import { pooled } from "@/lib/tools/analytics/inbox-extras.ts";

/*
 * Removing inboxes from campaigns, from the Inboxes page (5 Nov — inbox-removal.ts).
 *
 * This route: every open campaign, with its status and its inbox count, from EmailBison rather than the half-hourly
 * sync, because what can be changed is decided by the status it has now. About 25 + 66 requests, so a POST though it
 * changes nothing: a read here would be open to Campaign Analytics alone, and this belongs to Campaign Management.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  const store = await cookies();
  const session = await verifySessionToken(process.env.AUTH_SECRET ?? "", store.get(AUTH_COOKIE)?.value);
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const eb = createEmailBisonClient();
    const open = (await eb.getAllCampaigns()).filter((c) => isOpenStatus(c.status));
    const campaigns = await pooled(open, 6, async (c): Promise<OpenCampaign> => ({
      id: Number(c.id),
      name: String(c.name ?? `#${c.id}`),
      status: String(c.status).trim().toLowerCase(),
      inboxes: await eb.getCampaignSenderEmailCount(Number(c.id)),
    }));
    return NextResponse.json({ campaigns }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/campaigns/inboxes/removal]", e);
    return NextResponse.json({ error: describeEmailBisonError(e) }, { status: 502 });
  }
}
