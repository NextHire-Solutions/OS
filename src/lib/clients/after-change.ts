import "server-only";

import { getMasterClientList } from "@/lib/clients/master-list";
import { getClientCounts } from "@/lib/reconcile/client-counts";
import { getWeekly } from "@/lib/tools/client-health/weekly";
import { getPerformance } from "@/lib/workspace/performance";

/*
 * A client changed: every cached view of the client base starts over (6 Oct).
 *
 * The edit and status routes used to clear only Client Health's cache, so the
 * client list, the counts on every tool's client screen and Performance kept
 * serving the old value for up to a minute — and the master list's own
 * comment claimed otherwise. One call, used by every route that changes a
 * client, so none can be forgotten.
 */
export function clientsChanged(): void {
  getMasterClientList.invalidate();
  getClientCounts.invalidate();
  getPerformance.invalidate();
  getWeekly.invalidate();
}
