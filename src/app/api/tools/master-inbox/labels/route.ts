import { NextResponse, type NextRequest } from "next/server";

import { applyLabel, getLabels, removeLabel } from "@/lib/tools/master-inbox/labels";

/*
 * Thread labels.
 *
 * The most consequential write in the workspace. Applying one label wipes the
 * thread's others, fires a database trigger that creates a row in the client's
 * LIVE portal, posts to n8n and Slack, pushes the lead to Follow Up Boss, and
 * round-trips the decision to EmailBison.
 *
 * All of that is Master Inbox's own logic, ported rather than reimplemented —
 * see lib/tools/master-inbox/labels.ts for the two subtleties that are easy to
 * drop and expensive to lose.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getLabels());
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as
    | { thread_id?: string; label_id?: string; op?: string }
    | null;

  if (!body?.thread_id || !body?.label_id) {
    return NextResponse.json({ error: "thread_id and label_id are required" }, { status: 400 });
  }

  const result =
    body.op === "remove"
      ? await removeLabel(body.thread_id, body.label_id)
      : await applyLabel(body.thread_id, body.label_id);

  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
