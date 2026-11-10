import { NextResponse, type NextRequest } from "next/server";

import { admit, NO_STORE_HEADERS } from "@/lib/crm-preview/data-guard";
import { closedToClient } from "@/lib/crm-preview/portal-open";
import { crmViewerOf } from "@/lib/crm-preview/viewer";
import { guardRole, mayOpenPortal } from "@/lib/crm-preview/viewer-rules";
import { chatEmailOn } from "@/lib/portal-chat/mail";
import { clientCopy, clientThread, teamThreads } from "@/lib/portal-chat/threads";

/*
 * Reading the conversation with our team (4 Nov; lib/portal-chat/threads.ts). The same gate as the chat. GET ?client= :
 *
 *   a client   { role, thread }: their own conversation, if there's one to show
 *   our team   { role, threads, emailOn }: every open one on this portal; &thread= (a Slack link) adds that one
 *
 * Who is asking decides what the chat window shows, so it never has to be told by the page.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const viewer = await crmViewerOf(request);
  if (!viewer) return new NextResponse(null, { status: 404 });
  const who = viewer.email;
  const role = guardRole(viewer);

  const q = request.nextUrl.searchParams;
  const client = q.get("client") ?? "";
  if (!UUID.test(client)) return NextResponse.json({ error: "A client is required." }, { status: 400, headers: NO_STORE_HEADERS });
  if (!mayOpenPortal(viewer, client)) return new NextResponse(null, { status: 404 });
  if (await closedToClient(viewer, client as string)) return new NextResponse(null, { status: 404 });

  const gate = admit(who, role, "chat", request.headers);
  if (!gate.ok) return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });

  try {
    if (viewer.kind === "client") {
      const mine = await clientThread(client, who);
      return NextResponse.json({ role: viewer.kind, thread: mine ? clientCopy(mine) : null }, { headers: NO_STORE_HEADERS });
    }
    const named = q.get("thread");
    return NextResponse.json(
      { role: viewer.kind, threads: await teamThreads(client, named && UUID.test(named) ? named : null), emailOn: chatEmailOn() },
      { headers: NO_STORE_HEADERS },
    );
  } catch (e) {
    // A moment's trouble: the chat carries on as the assistant. (Before migration 0047 it isn't trouble: threads.ts answers "none".)
    console.error(JSON.stringify({ at: "[crm-preview] person-chat failed", who, client, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
    return NextResponse.json({ error: "Not available just now." }, { status: 502, headers: NO_STORE_HEADERS });
  }
}
