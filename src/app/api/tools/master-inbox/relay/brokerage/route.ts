import { NextResponse } from "next/server";

import { clientsChanged } from "@/lib/clients/after-change";
import { requireRelaySession } from "@/lib/tools/master-inbox/auth/require-relay";
import { RelayActionError, saveBrokerageSettings } from "@/lib/tools/master-inbox/relay/relay";

/*
 * One brokerage’s hand-off settings (admins, and the people the page is opened to by name — auth/require-relay.ts): its own on/off switch (the
 * pilot), who receives (the introduction contacts by territory, or one
 * address), an hourly-cap and mode override, and where its agents enter the
 * portal pipeline (os_clients.pipeline_entry, 0036: on 'interested', a hand-off
 * that has really gone adds the agent to it — relay/portal-entry.ts).
 *
 * PUT { osClientId, enabled?, recipients?, address?, hourlyCap?, mode?, pipelineEntry? }
 */
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  const session = await requireRelaySession();
  if (session instanceof NextResponse) return session;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const osClientId = typeof body?.osClientId === "string" ? body.osClientId : "";
  if (!osClientId) return NextResponse.json({ error: "osClientId is required" }, { status: 400 });
  try {
    const saved = await saveBrokerageSettings(osClientId, body);
    clientsChanged();
    console.log(`[brokerage-relay] ${session.user.email} changed ${osClientId}: ${JSON.stringify({ ...body, osClientId: undefined })}`);
    return NextResponse.json({ ok: true, ...saved });
  } catch (e) {
    if (e instanceof RelayActionError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 502 });
  }
}
