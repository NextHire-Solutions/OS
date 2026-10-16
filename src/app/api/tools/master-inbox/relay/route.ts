import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/tools/master-inbox/auth/require-admin";
import { RelayActionError, relayOverview, saveGlobalSettings } from "@/lib/tools/master-inbox/relay/relay";

/*
 * The brokerage hand-off's Settings (admins only — this decides what reaches
 * client brokerages).
 *
 * GET → the switches, the server's own locks (whether live sending is allowed
 *       on this server and whether a Postmark token is set — never the token),
 *       every brokerage's settings, the held campaigns and the recent log.
 * PUT → the global switches: { enabled, practiceMode, mode, hourlyCap,
 *       forwardLaterReplies, countsAsIntroduction } — any subset.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireAdminSession();
  if (session instanceof NextResponse) return session;
  try {
    return NextResponse.json(await relayOverview());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the hand-off settings" }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  const session = await requireAdminSession();
  if (session instanceof NextResponse) return session;
  const body = await request.json().catch(() => null);
  try {
    const settings = await saveGlobalSettings(body, session.user.email ?? "unknown");
    console.log(`[brokerage-relay] ${session.user.email} changed the switches: ${JSON.stringify(body)}`);
    return NextResponse.json({ ok: true, settings });
  } catch (e) {
    if (e instanceof RelayActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 502 });
  }
}
