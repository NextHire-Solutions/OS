import "server-only";

import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";
import { getMasterInboxSupabase, workspaceId } from "@/lib/tools/master-inbox/supabase";

import { threadsByDay } from "./overview-model";

/*
 * "Interested" for Home, from Master Inbox (13 Oct: "should pull from
 * MasterInbox").
 *
 * The threads carrying the Interested label — or Introduction, which replaces
 * it — counted once each, by the day the label went on. The same rule as
 * Master Inbox's own feed (api/tools/master-inbox/clients/intros), which is
 * what Client Health counts from; only the window differs: this reads the
 * last `days` days rather than everything since the first reply.
 *
 * Reads only. Paged — an unpaged read stops at 1,000 rows without a word.
 */

/** The business's calendar day (Eastern) for a timestamp. */
export const easternDay = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export async function interestedByDay(days: number): Promise<Map<string, number>> {
  const db = getMasterInboxSupabase();
  const ws = await workspaceId();

  const { data: labels, error } = await db
    .from("labels")
    .select("id, name")
    .eq("workspace_id", ws)
    .or("name.ilike.Interested,name.ilike.Introduction");
  if (error) throw new Error(`Master Inbox labels: ${error.message}`);
  const ids = ((labels ?? []) as { id: string }[]).map((l) => l.id);
  if (ids.length === 0) return new Map();

  // A day of slack on the far side: the window is cut by calendar day below.
  const since = new Date(Date.now() - (days + 1) * 86_400_000).toISOString();
  const rows = await fetchAllRows<{ target_id: string; assigned_at: string }>(({ from, to }) =>
    db
      .from("label_assignments")
      .select("target_id, assigned_at")
      .eq("workspace_id", ws)
      .eq("target_type", "thread")
      .in("label_id", ids)
      .gte("assigned_at", since)
      .order("assigned_at", { ascending: false })
      .range(from, to),
  );
  return threadsByDay(rows, easternDay);
}
