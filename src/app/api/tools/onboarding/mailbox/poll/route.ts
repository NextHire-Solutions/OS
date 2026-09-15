import { NextResponse } from "next/server";

import { pollReplies } from "@/lib/tools/onboarding/gmail-replies";

/*
 * "Check replies now" — the tool's `pollRepliesNow` server action. READS the
 * connected mailbox for replies on threads the tool sent; sends nothing.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  try {
    return NextResponse.json({ ok: true, ...(await pollReplies()) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Poll failed" }, { status: 500 });
  }
}
