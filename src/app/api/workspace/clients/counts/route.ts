import { NextResponse } from "next/server";

import { getClientCounts } from "@/lib/reconcile/client-counts";

/* The master record's client count, and how each tool's table relates to it. Names only. */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getClientCounts());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not count clients" }, { status: 502 });
  }
}
