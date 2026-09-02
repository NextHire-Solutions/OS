import { NextResponse } from "next/server";
import { getAllSnapshots } from "@/lib/status/store";
import { aggregate } from "@/lib/status/derive";

// Never let Next cache a status response — the store already owns freshness,
// and a second cache layer here would make "Checked 12s ago" a lie.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  const snapshots = await getAllSnapshots({ force });
  const summary = aggregate(snapshots.map((s) => s.state));

  return NextResponse.json(
    { snapshots, summary, generatedAt: new Date().toISOString() },
    {
      headers: {
        // Private: these payloads carry upstream KPIs.
        "cache-control": "private, max-age=15, stale-while-revalidate=45",
      },
    },
  );
}
