import { NextResponse, type NextRequest } from "next/server";

import { failure, sameOrigin, ticketsViewer } from "@/lib/tools/tickets/route-auth";
import { changeTicket, removeTicket, ticketDetail } from "@/lib/tools/tickets/service";
import type { TicketStatus } from "@/lib/tools/tickets/ticket-rules";

/*
 * GET    /api/tools/tickets/<id or number> — the conversation, its timeline and who else has it open.
 * PATCH  { status } | { assignee } | { snooze: iso | null } | { client: id | null } — one change, logged.
 * DELETE — remove the conversation from Tickets for good (admins, or a teammate whose inbox holds it).
 */
export const dynamic = "force-dynamic";

const STATUSES: TicketStatus[] = ["open", "waiting", "done", "ignored"];
const ID = /^(\d{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  const { id } = await params;
  if (!ID.test(id)) return NextResponse.json({ error: "No such ticket" }, { status: 404 });
  try {
    const d = await ticketDetail(id, viewer.email, viewer.admin);
    if (!d) return NextResponse.json({ error: "This ticket was removed or never existed" }, { status: 404 });
    return NextResponse.json(d, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  if (!sameOrigin(request)) return NextResponse.json({ error: "Refused" }, { status: 403 });
  const { id } = await params;
  if (!ID.test(id)) return NextResponse.json({ error: "No such ticket" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  try {
    if ("status" in body) {
      if (!STATUSES.includes(body.status as TicketStatus)) return NextResponse.json({ error: "Unknown status" }, { status: 400 });
      await changeTicket(id, viewer.email, { type: "status", to: body.status as TicketStatus });
    } else if ("assignee" in body) {
      const to = body.assignee === null ? null : typeof body.assignee === "string" ? body.assignee : undefined;
      if (to === undefined) return NextResponse.json({ error: "Assign to whom?" }, { status: 400 });
      await changeTicket(id, viewer.email, { type: "assign", to });
    } else if ("snooze" in body) {
      const until = body.snooze === null ? null : typeof body.snooze === "string" && Number.isFinite(Date.parse(body.snooze)) ? new Date(body.snooze).toISOString() : undefined;
      if (until === undefined) return NextResponse.json({ error: "Snooze until when?" }, { status: 400 });
      if (until && Date.parse(until) - Date.now() > 366 * 86_400_000) return NextResponse.json({ error: "Snooze for a year at most" }, { status: 400 });
      await changeTicket(id, viewer.email, { type: "snooze", until });
    } else if ("client" in body) {
      const to = body.client === null ? null : typeof body.client === "string" ? body.client : undefined;
      if (to === undefined) return NextResponse.json({ error: "Which client?" }, { status: 400 });
      await changeTicket(id, viewer.email, { type: "client", to });
    } else {
      return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  if (!sameOrigin(request)) return NextResponse.json({ error: "Refused" }, { status: 403 });
  const { id } = await params;
  if (!ID.test(id)) return NextResponse.json({ error: "No such ticket" }, { status: 404 });
  try {
    await removeTicket(id, viewer.email, viewer.admin);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
