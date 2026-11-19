import { NextResponse, type NextRequest } from "next/server";

import { failure, sameOrigin, ticketsViewer } from "@/lib/tools/tickets/route-auth";
import { addNote } from "@/lib/tools/tickets/service";

/* POST /api/tools/tickets/<id>/notes { body, mentions: [email] } — an internal note on the ticket's timeline. */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  if (!sameOrigin(request)) return NextResponse.json({ error: "Refused" }, { status: 403 });
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as { body?: unknown; mentions?: unknown } | null;
  if (!body || typeof body.body !== "string") return NextResponse.json({ error: "Write something first" }, { status: 400 });
  const mentions = Array.isArray(body.mentions) ? body.mentions.filter((m): m is string => typeof m === "string").slice(0, 20) : [];
  try {
    await addNote(id, viewer.email, body.body, mentions);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
