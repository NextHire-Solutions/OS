import { NextResponse, type NextRequest } from "next/server";

import { clientStatusFeed } from "@/lib/clients/status-feed";

/*
 * The platform client-status feed, mastered in `os_clients`.
 *
 * Same JSON as Client Health's /api/clients/status and the OS's mirror of it,
 * so MasterInbox can be pointed here by changing CLIENT_STATUS_URL alone —
 * no code change on its side. That is the Layer 2 cutover: the OS becomes the
 * client record, and the tools read it.
 *
 * Auth: `x-admin-token` against OS_CLIENT_STATUS_TOKEN. Unset means 500, never
 * open — the same rule the other status endpoints keep, because "unset = allow"
 * would turn one missing Railway variable into a public client list.
 *
 * NOT YET THE LIVE FEED. `os_clients` does not yet cover every client that
 * MasterInbox holds a portal for, and a consumer only follows the clients a
 * feed names. Pointing MasterInbox here before the roster is complete would
 * simply stop those clients being driven at all. Compare this endpoint against
 * the Client Health one first; cut over when the names line up.
 */
export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const expected = process.env.OS_CLIENT_STATUS_TOKEN?.trim();
  if (!expected) {
    return NextResponse.json(
      { error: "server misconfigured: OS_CLIENT_STATUS_TOKEN not set" },
      { status: 500 },
    );
  }
  const supplied = request.headers.get("x-admin-token");
  if (!supplied || !safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await clientStatusFeed());
  } catch (error) {
    // A consumer must be able to tell "the feed is broken" from "the feed says
    // nobody is active" — so this is a 500 with a reason, never an empty list.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "os_clients is unreachable" },
      { status: 500 },
    );
  }
}
