import { NextResponse, type NextRequest } from "next/server";

import { getInbox, parseInboxQuery } from "@/lib/tools/master-inbox/inbox-view";

/*
 * One page of the inbox.
 *
 * 9,862 open threads, so paging is not an optimisation — the tool's own page
 * size of 50 is used unchanged, and the reasons for it are in its comments.
 *
 * Read-only. Writes go through Master Inbox's own API, because labelling a
 * thread fires a trigger that creates a row in a client's live portal.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return NextResponse.json(await getInbox(parseInboxQuery(request.nextUrl.searchParams)));
}
