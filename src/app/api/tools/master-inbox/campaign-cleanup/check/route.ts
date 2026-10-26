import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/tools/master-inbox/auth/require-admin";
import { CampaignListError, checkEmail } from "@/lib/clients/campaign-lists/sweep";

/*
 * "Check one email" (admins): which of this client's campaigns the address
 * is on, and what the clean-up would do with each right now. One EmailBison
 * read; nothing is changed or recorded.
 *
 * POST { clientId, email }
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await requireAdminSession();
  if (session instanceof NextResponse) return session;
  const body = (await request.json().catch(() => null)) as { clientId?: unknown; email?: unknown } | null;
  if (typeof body?.clientId !== "string" || typeof body?.email !== "string") {
    return NextResponse.json({ error: "Choose a client and enter an email address." }, { status: 400 });
  }
  try {
    return NextResponse.json(await checkEmail(body.clientId, body.email));
  } catch (e) {
    if (e instanceof CampaignListError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not check" }, { status: 502 });
  }
}
