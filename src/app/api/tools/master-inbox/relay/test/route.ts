import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/tools/master-inbox/auth/require-admin";
import { RelayActionError, saveTestRecipients, sendRelayTest } from "@/lib/tools/master-inbox/relay/relay";

/*
 * POST { relayId? } — a TEST send to our own test address(es) only
 * (relay/test-send.ts): a sample with made-up words, or a copy of one prepared
 * hand-off. Never a brokerage or an agent; never the live switch; changes no
 * hand-off.
 * PUT { recipients } — set the test address(es) (23 Oct): our own domains or
 * Team access, never a brokerage contact, at most three — checked here and
 * again at every send. Admins only, both.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await requireAdminSession();
  if (session instanceof NextResponse) return session;
  const body = (await request.json().catch(() => null)) as { relayId?: unknown } | null;
  const relayId = typeof body?.relayId === "string" && /^[0-9a-f-]{36}$/i.test(body.relayId) ? body.relayId : null;
  if (body?.relayId !== undefined && body?.relayId !== null && !relayId) return NextResponse.json({ error: "No such hand-off." }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...(await sendRelayTest(relayId, session.user.email ?? "unknown")) });
  } catch (e) {
    if (e instanceof RelayActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "The test could not be sent" }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  const session = await requireAdminSession();
  if (session instanceof NextResponse) return session;
  const body = (await request.json().catch(() => null)) as { recipients?: unknown } | null;
  try {
    return NextResponse.json({ ok: true, recipients: await saveTestRecipients(body?.recipients, session.user.email ?? "unknown") });
  } catch (e) {
    if (e instanceof RelayActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save the test address" }, { status: 502 });
  }
}
