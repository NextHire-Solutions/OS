import { NextResponse } from "next/server";

import { CLIENT_STATUSES, setClientStatus, type ClientStatus } from "@/lib/clients/os-clients";
import { propagateStatus } from "@/lib/clients/status-propagate";

/*
 * Change a client's status. The only mutation the Clients screen performs.
 *
 * There is no DELETE here and there will not be one. A client that stops
 * trading becomes `churned` and can become `active` again — portal tokens and
 * history have to survive, and "we removed the row" is not a recoverable
 * state. `status` is the only field that moves.
 *
 * Writes to `os_clients`, then propagates: Client Health, Analytics, and a
 * nudge that makes MasterInbox re-read the feed and reconcile the portal.
 *
 * That reverses what this comment used to say ("no tool is contacted"). The
 * reason is the spec's §10 and §21 — CHANGE ONCE, UPDATE EVERYWHERE. A status
 * the tools never act on is a note in a table, not a decision, and in practice
 * it meant a churned client kept an open portal until somebody remembered.
 *
 * This does NOT replace the Client Health -> MasterInbox push. The standalone
 * tools stay in use, so a status set directly in Client Health must keep
 * propagating on its own. This is a second entry point, not a replacement.
 *
 * Billing and campaigns are deliberately NOT propagated. They stay deliberate
 * acts in the tools that own them, because both cost money to get wrong in a
 * way a portal switch does not.
 *
 * Every leg's outcome is returned. A propagation that half-worked must say so
 * rather than report a clean success — see lib/clients/status-propagate.ts.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const { id, status } = (body ?? {}) as { id?: unknown; status?: unknown };
  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (typeof status !== "string" || !CLIENT_STATUSES.includes(status as ClientStatus)) {
    return NextResponse.json(
      { error: `status must be one of ${CLIENT_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const client = await setClientStatus(id, status as ClientStatus);

    /*
     * After the master write, never before. The propagation writes Client
     * Health, then Analytics, then nudges Master Inbox to re-read the feed —
     * and a nudge that raced the commit would make it read the status this
     * call just replaced.
     *
     * It never throws: os_clients has already committed, and a tool being
     * down must not undo that or fail the request. The per-leg outcomes come
     * back so the screen can say exactly what did and did not travel, rather
     * than claiming a propagation that never happened.
     */
    const propagation = await propagateStatus(client, client.status);
    return NextResponse.json({ ok: true, client, propagation });
  } catch (error) {
    console.error("[api/workspace/clients/status]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update the status" },
      { status: 502 },
    );
  }
}
