import { NextResponse } from "next/server";

import { loadDatabaseClients } from "@/lib/tools/database/clients";

/*
 * The Database view's clients — §8's twelve fields, one row per client.
 *
 * Under /api/tools/agent-search/ on purpose: the screen lives at
 * /search/clients, and tool-paths.ts gates both by that prefix, so whoever may
 * open the screen may read its data and nobody else. A /database/ segment
 * would have been ungated (toolForPath returns null for unknown segments).
 *
 * Read-only.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await loadDatabaseClients());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load the Database clients" }, { status: 502 });
  }
}
