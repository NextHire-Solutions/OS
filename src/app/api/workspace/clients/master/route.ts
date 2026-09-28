import { NextResponse } from "next/server";

import { getMasterClientList } from "@/lib/clients/master-list";

/*
 * The master client list — every §6 field for every client (master-list.ts).
 * `?fresh=1` drops the one-minute cache, which the Clients page asks for right
 * after an edit so the row it just changed is not served stale.
 *
 * The proxy has already verified the session.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (new URL(request.url).searchParams.get("fresh") === "1") getMasterClientList.invalidate();
    return NextResponse.json(await getMasterClientList());
  } catch (error) {
    console.error("[api/workspace/clients/master]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load the master client list" },
      { status: 502 },
    );
  }
}
