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
 *        a definite Postmark refusal, or "Check again" on a held one (which
 *        never sends in one-click mode). Every check runs again first. In
 *        practice mode it records what would have gone and sends nothing; it
 *        sends only when every lock is open, and only in the mode the button
 *        showed (otherwise `notice` says it was prepared again).
 *
 * WHO MAY PRESS IT: anyone with the Master Inbox switch — the proxy gates
 * every /api/tools/master-inbox/* request on the `inbox` grant
 * (workspace/tool-paths.ts), the same switch that lets a person send a reply
 * or press Introduce on this conversation, which already emails the same
 * brokerage people. The switches themselves (Settings → Brokerage hand-off)
 * are admins only. Pinned by relay-access.test.ts.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await context.params;
  await requireSession();
  try {
    const { available, records } = await threadRelays(threadId);
    // `today` from the server: a hand-off from another day shows its date, not just "at 10:42 AM".
    const today = new Date().toISOString();
    return NextResponse.json({ available, records: records.map((r) => ({ ...r, line: relayLine(r, today) })) });
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
    const { notice, ...record } = await sendToBrokerage(relayId, threadId, who);
    console.log(`[brokerage-relay] ${who} pressed the hand-off button on ${threadId}: ${record.status}${notice ? ` (${notice})` : ""}`);
    return NextResponse.json({ ok: true, notice, record: { ...record, line: relayLine(record, new Date().toISOString()) } });
  } catch (e) {
    if (e instanceof RelayActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "The hand-off failed" }, { status: 502 });
  }
}
