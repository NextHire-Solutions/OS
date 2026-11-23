import { NextResponse, type NextRequest } from "next/server";

import { replyContext, sendTicketReply } from "@/lib/tools/tickets/reply-service";
import { failure, ticketsViewer } from "@/lib/tools/tickets/route-auth";

/*
 * GET  /api/tools/tickets/<id or number>/reply — the reply box: which inbox it goes from (and the other choice), to whom,
 *      who can be copied in, the signature, or why it can't go from Tickets.
 * POST { from, text, cc: string[], nonce, replyTo } — send it (reply.ts). Anyone with the Tickets switch (24 Nov, the user).
 *      A refusal says `sent: false` (nothing went); anything else that isn't ok means it may have gone (`sent: "unknown"`).
 *      The OS's own pages only: an Origin header naming this host is required, not just tolerated.
 */
export const dynamic = "force-dynamic";

const ID = /^(\d{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  const { id } = await params;
  if (!ID.test(id)) return NextResponse.json({ error: "No such ticket" }, { status: 404 });
  try {
    return NextResponse.json(await replyContext(id), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}

/** Sending email: the request must come from a page of this OS (a missing Origin is refused too). */
function fromThisOs(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === (request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  if (!fromThisOs(request)) return NextResponse.json({ error: "Refused" }, { status: 403 });
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return NextResponse.json({ error: "Refused" }, { status: 415 });
  const { id } = await params;
  if (!ID.test(id)) return NextResponse.json({ error: "No such ticket" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.from !== "string" || typeof body.text !== "string" || typeof body.nonce !== "string" || (body.cc !== undefined && !Array.isArray(body.cc)) || (body.replyTo !== null && typeof body.replyTo !== "string")) {
    return NextResponse.json({ error: "Nothing to send", sent: false }, { status: 400 });
  }
  try {
    const r = await sendTicketReply(id, viewer.email, { from: body.from, text: body.text, nonce: body.nonce, replyTo: (body.replyTo as string | null) ?? null, cc: ((body.cc as unknown[]) ?? []).filter((x): x is string => typeof x === "string").slice(0, 50) });
    if (r.ok) return NextResponse.json(r);
    return NextResponse.json({ error: r.error, code: r.code, sent: r.sent }, { status: r.status });
  } catch (e) {
    return failure(e);
  }
}
