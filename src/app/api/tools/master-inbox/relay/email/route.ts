import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/tools/master-inbox/auth/require-admin";
import { RelayActionError, relayEmailView } from "@/lib/tools/master-inbox/relay/relay";

/*
 * GET ?id=<hand-off id> — one hand-off's email exactly as it was prepared:
 * From, To, Reply-To, subject, the HTML and plain-text bodies, the extra
 * headers and how Postmark would be asked to send it (relay.ts
 * relayEmailView). For checking the practice week line by line (23 Oct).
 * Admins only, as the rest of the hand-off's Settings. Reads only — sends
 * nothing, changes nothing.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private, max-age=0" };

export async function GET(request: Request) {
  const session = await requireAdminSession();
  if (session instanceof NextResponse) return session;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "No such hand-off." }, { status: 400, headers: NO_STORE });
  try {
    return NextResponse.json(await relayEmailView(id), { headers: NO_STORE });
  } catch (e) {
    if (e instanceof RelayActionError) return NextResponse.json({ error: e.message }, { status: e.status, headers: NO_STORE });
    return NextResponse.json({ error: e instanceof Error ? e.message : "The hand-off could not be read" }, { status: 502, headers: NO_STORE });
  }
}
