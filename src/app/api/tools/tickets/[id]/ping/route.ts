import { NextResponse, type NextRequest } from "next/server";

import { leave, touch, viewers } from "@/lib/tools/tickets/presence";
import { failure, sameOrigin, ticketsViewer } from "@/lib/tools/tickets/route-auth";
import { logGmailOpen, markSeen } from "@/lib/tools/tickets/service";

/*
 * POST /api/tools/tickets/<id>/ping { viewing?: boolean, seen?: true, gmail?: true }
 * The open ticket's heartbeat: "I'm looking at this" (every 15s), "I've read it", "I opened it in Gmail".
 * Answers with who else is looking.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  if (!sameOrigin(request)) return NextResponse.json({ error: "Refused" }, { status: 403 });
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "No such ticket" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { viewing?: unknown; seen?: unknown; gmail?: unknown };
  try {
    if (body.viewing === true) touch(id, viewer.email);
    if (body.viewing === false) leave(id, viewer.email);
    if (body.seen === true) await markSeen(id, viewer.email);
    if (body.gmail === true) await logGmailOpen(id, viewer.email);
    return NextResponse.json({ viewers: viewers(id, viewer.email) });
  } catch (e) {
    return failure(e);
  }
}
