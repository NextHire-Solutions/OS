import { NextResponse } from "next/server";

import { scraper } from "@/lib/tools/agent-search/scraper";

/*
 * Run the AUTOMATIC MLS monitor now — the same code the 24h scheduler runs.
 *
 * Distinct from mls-scan, and the difference matters. mls-scan is a read-only
 * job the browser diffs against its own localStorage. This one diffs against
 * the SERVER baseline in mls_monitor_state, alerts Slack on any add/remove or
 * login failure, and then writes the fresh baseline — but only for accounts
 * that scanned cleanly, so a stale password can never wipe an account's
 * history or fire a false "removed".
 */
export const dynamic = "force-dynamic";

export async function POST() {
  const r = await scraper.runMlsMonitor();
  return NextResponse.json(r.body, { status: r.status });
}
