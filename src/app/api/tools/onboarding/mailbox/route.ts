import { NextResponse } from "next/server";

import { disconnectGoogle } from "@/lib/tools/onboarding/google-oauth";
import { getMailboxStatus } from "@/lib/tools/onboarding/mailbox";

/*
 * The connected mailbox.
 *   GET     its status, with the live connection check
 *   DELETE  forget it — the tool's `disconnectGoogle` server action
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getMailboxStatus());
}

export async function DELETE() {
  try {
    await disconnectGoogle();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not disconnect" }, { status: 500 });
  }
}
