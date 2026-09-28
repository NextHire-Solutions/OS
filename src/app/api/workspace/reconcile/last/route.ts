import { NextResponse } from "next/server";

import { lastCheck } from "@/lib/reconcile/last-result";

/*
 * The latest daily consistency check, for Home. Null until the first run after
 * a start (about 90 seconds). Read-only; runs nothing.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ last: lastCheck() });
}
