import { NextResponse } from "next/server";

import { CLIENT_STATUSES, setClientStatus, type ClientStatus } from "@/lib/clients/os-clients";
import { pushPortalStatus } from "@/lib/portals/status-push";

/*
 * Change a client's status. The only mutation the Clients screen performs.
 *
 * There is no DELETE here and there will not be one. A client that stops
 * trading becomes `churned` and can become `active` again — portal tokens and
 * history have to survive, and "we removed the row" is not a recoverable
 * state. `status` is the only field that moves.
 *
 * Writes to `os_clients`, then nudges MasterInbox to reconcile portals.
 *
 * That nudge reverses what this comment used to say ("no tool is contacted").
 * The reason is the architecture spec's Layer 2: client information is
 * mastered in the OS, and the tools follow it. A status that the tools do not
 * act on is a note in a table, not a decision — and in practice it meant a
 * churned client kept an open portal until somebody remembered.
 *
 * Billing and campaigns are NOT included in that reversal. They stay
 * deliberate acts in the tools that own them, because both cost money to get
 * wrong in a way a portal switch does not.
 *
 * The push is fire-and-forget and currently a no-op until its two env vars
 * are set — see lib/portals/status-push.ts for why that is deliberate.
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
    // After the write, never before: a push that races the commit would make
    // MasterInbox read the status this call just replaced.
    pushPortalStatus(`${client.name} -> ${client.status}`);
    return NextResponse.json({ ok: true, client });
  } catch (error) {
    console.error("[api/workspace/clients/status]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update the status" },
      { status: 502 },
    );
  }
}
