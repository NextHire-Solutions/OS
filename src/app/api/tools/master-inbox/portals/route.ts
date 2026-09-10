import { NextResponse } from "next/server";

import { getPortals } from "@/lib/tools/master-inbox/portals";

/*
 * The staff view of the client portals.
 *
 * Read-only, and more firmly than elsewhere: these are the tables the 48 live
 * portals are built on. A client's link stops working the moment its token,
 * enabled flag or slug changes — portal-guard.ts refuses those writes, and
 * nothing here writes at all.
 *
 * No Follow Up Boss key is selected; only whether one is set, decided on the
 * server.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getPortals());
}
