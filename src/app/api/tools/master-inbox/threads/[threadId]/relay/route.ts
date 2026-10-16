import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/workspace";
import { RelayActionError, sendToBrokerage, threadRelays } from "@/lib/tools/master-inbox/relay/relay";
import { relayLine } from "@/lib/tools/master-inbox/relay/wording";

/*
 * The brokerage hand-off on one conversation (plan §3.5: "Every send is
 * recorded on the conversation").
 *
 * GET  → every hand-off considered for this conversation, with the line the
 *        conversation shows ("Sent to Angela at 10:42"). Reads only.
 * POST { relayId } → "Send to brokerage" (one-click mode), "Try again" after
 *        a definite Postmark refusal, or "Check again" on a held one. Every
 *        check runs again first. In practice mode it records what would have
 *        gone and sends nothing; it sends only when every lock is open.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await context.params;
  await requireSession();
  try {
    const { available, records } = await threadRelays(threadId);
    return NextResponse.json({ available, records: records.map((r) => ({ ...r, line: relayLine(r) })) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the hand-offs" }, { status: 502 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await context.params;
  const session = await requireSession();
  const who = session.user.email;
  if (!who) return NextResponse.json({ error: "Sign in again — the hand-off records who pressed it." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { relayId?: unknown } | null;
  const relayId = typeof body?.relayId === "string" ? body.relayId : "";
  if (!relayId) return NextResponse.json({ error: "relayId is required" }, { status: 400 });
  try {
    const record = await sendToBrokerage(relayId, threadId, who);
    console.log(`[brokerage-relay] ${who} pressed Send to brokerage on ${threadId}: ${record.status}`);
    return NextResponse.json({ ok: true, record: { ...record, line: relayLine(record) } });
  } catch (e) {
    if (e instanceof RelayActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "The hand-off failed" }, { status: 502 });
  }
}
