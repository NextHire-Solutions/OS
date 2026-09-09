import { NextResponse, type NextRequest } from "next/server";

import { setThreadSeen, setThreadStatus, type ThreadStatus } from "@/lib/tools/master-inbox/actions";

/*
 * Thread actions — archive, trash, spam, restore, read/unread.
 *
 * Writes to Master Inbox's own database, scoped by workspace and by an
 * explicit id list. The proxy has already verified the workspace session, so
 * an unauthenticated request never reaches this handler.
 *
 * Labelling is NOT here. It fires four external systems and creates a row in
 * the client's live portal, so it lands as its own change with its own
 * testing. See lib/tools/master-inbox/actions.ts.
 */
export const dynamic = "force-dynamic";

const STATUSES = new Set<ThreadStatus>(["open", "archived", "trash", "spam", "reminder"]);

export async function POST(request: NextRequest) {
  let body: { action?: string; thread_ids?: unknown; status?: string; seen?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const ids = Array.isArray(body.thread_ids) ? body.thread_ids.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "thread_ids is required" }, { status: 400 });
  }

  if (body.action === "status") {
    const status = body.status as ThreadStatus | undefined;
    // Checked against the list rather than passed through: an unknown status
    // would be written verbatim and every view filters on this column.
    if (!status || !STATUSES.has(status)) {
      return NextResponse.json(
        { error: `status must be one of ${[...STATUSES].join(", ")}` },
        { status: 400 },
      );
    }
    const result = await setThreadStatus(ids, status);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  }

  if (body.action === "seen") {
    if (typeof body.seen !== "boolean") {
      return NextResponse.json({ error: "seen must be true or false" }, { status: 400 });
    }
    const result = await setThreadSeen(ids, body.seen);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
