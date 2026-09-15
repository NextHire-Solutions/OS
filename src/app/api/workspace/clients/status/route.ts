import { NextResponse } from "next/server";

import { CLIENT_STATUSES, setClientStatus, type ClientStatus } from "@/lib/clients/os-clients";

/*
 * Change a client's status. The only mutation the Clients screen performs.
 *
 * There is no DELETE here and there will not be one. A client that stops
 * trading becomes `churned` and can become `active` again — portal tokens and
 * history have to survive, and "we removed the row" is not a recoverable
 * state. `status` is the only field that moves.
 *
 * Writes to `os_clients` only. No tool is contacted: this records what the
 * business says about a client, and does not pause billing, disable a portal
 * or stop a campaign. Those remain deliberate acts in the tools that own them.
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
    return NextResponse.json({ ok: true, client });
  } catch (error) {
    console.error("[api/workspace/clients/status]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update the status" },
      { status: 502 },
    );
  }
}
