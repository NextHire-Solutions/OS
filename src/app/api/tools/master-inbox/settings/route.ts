import { NextResponse } from "next/server";

import { getSettings } from "@/lib/tools/master-inbox/settings";

/*
 * Master Inbox's settings, read-only.
 *
 * The loader never selects a secret — not the encrypted provider key, not a
 * client's Follow Up Boss key — and reduces "is one set" to a boolean before
 * anything leaves the server.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getSettings());
}
