import { NextResponse, type NextRequest } from "next/server";

import { failure, sameOrigin, ticketsViewer } from "@/lib/tools/tickets/route-auth";
import { disconnectMailbox, mailboxesPage } from "@/lib/tools/tickets/service";

/*
 * GET    /api/tools/tickets/inboxes — the connected inboxes, the team's coverage, and whether Google is set up.
 * POST   { sync: true } — fetch new mail now, rather than within the minute (after connecting).
 * DELETE ?email= — disconnect an inbox (its owner, whoever connected it, or an admin). Tickets already shared stay.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  try {
    return NextResponse.json(await mailboxesPage(viewer.email, viewer.admin), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(request: NextRequest) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  if (!sameOrigin(request)) return NextResponse.json({ error: "Refused" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { sync?: unknown };
  if (body.sync !== true) return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  // In the background: a first fill takes a minute or two, and the screen polls.
  void import("@/lib/tools/tickets/runner").then((r) => r.runTicketsSync()).catch((e) => console.error("[tickets] sync now:", e instanceof Error ? e.message : e));
  return NextResponse.json({ ok: true, started: true });
}

export async function DELETE(request: NextRequest) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  if (!sameOrigin(request)) return NextResponse.json({ error: "Refused" }, { status: 403 });
  const email = request.nextUrl.searchParams.get("email") ?? "";
  if (!email.includes("@")) return NextResponse.json({ error: "Which inbox?" }, { status: 400 });
  try {
    await disconnectMailbox(email, viewer.email, viewer.admin);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
