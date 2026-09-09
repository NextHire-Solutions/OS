import { NextResponse, type NextRequest } from "next/server";

import { getThread } from "@/lib/tools/master-inbox/inbox-view";

/*
 * One conversation, with its messages.
 *
 * Loaded on demand rather than with the list: a thread carries every message
 * body, and 50 of those in a list payload would be most of the transfer for
 * something the reader opens one of.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "A thread id is required" }, { status: 400 });
  return NextResponse.json(await getThread(id));
}
