import { NextResponse, type NextRequest } from "next/server";

import { failure, ticketsViewer } from "@/lib/tools/tickets/route-auth";
import { listTickets } from "@/lib/tools/tickets/service";
import { isView } from "@/lib/tools/tickets/views";

/*
 * GET /api/tools/tickets?view=open&client=&mailbox=&q=&offset= — one view of the tickets, with every view's count,
 * who is looking at what, and the people and clients the screen's pickers need.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  const p = request.nextUrl.searchParams;
  const view = isView(p.get("view")) ? (p.get("view") as Parameters<typeof listTickets>[0]["view"]) : "open";
  try {
    const data = await listTickets({
      view, me: viewer.email, admin: viewer.admin,
      client: p.get("client") || null, mailbox: p.get("mailbox") || null, q: p.get("q"),
      offset: Math.max(0, Math.min(5000, Number(p.get("offset") ?? 0) || 0)),
      limit: Math.max(1, Math.min(500, Number(p.get("limit") ?? 100) || 100)),
    });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}
