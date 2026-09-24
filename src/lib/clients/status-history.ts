import "server-only";

import { osTable } from "./os-db";

/*
 * When each client's current status was set — the spec's §12 lifecycle dates.
 *
 *     Important dates include: ... Pause date, Churn date, Reactivation date
 *
 * Before migration 0012 these were unanswerable: churn was a boolean with no
 * date, which is why the Performance screen still says "needs status history
 * for a rate". `os_client_status_history` answers them now, and this reads the
 * latest row per client so a screen can say "Churned 24 Sep" rather than just
 * "Churned".
 *
 * ---------------------------------------------------------------------------
 * WHY A SEEDED ROW IS MARKED AS SUCH
 *
 * Migration 0012 wrote one row per existing client dated from that client's
 * `created_at`, with `from_status` NULL, because the earlier changes were
 * never recorded. That row means "this is the status we found", NOT "the
 * status changed on this date".
 *
 * The difference matters on screen. Reading a seeded row as a churn date
 * would date every historical churn to the day the client was CREATED, which
 * is not merely imprecise — it is wrong in a way that looks precise. So
 * `recorded` distinguishes them and the UI says "known since" for one and
 * "changed" for the other.
 *
 * Degrades to an empty map if the table is unreadable: a missing date costs a
 * line of subtext, never the screen.
 */

export interface StatusMoment {
  status: string;
  at: string;
  /** True when this is 0012's seeded row — a status we found, not a change. */
  recorded: boolean;
  /** The status it came from. Null for a seeded row. */
  from: string | null;
}

export async function latestStatusMoments(): Promise<Map<string, StatusMoment>> {
  const out = new Map<string, StatusMoment>();
  try {
    const { data, error } = await osTable("os_client_status_history")
      .select("os_client_id, from_status, to_status, changed_at")
      .order("changed_at", { ascending: false })
      .limit(5000);
    if (error) return out;
    for (const row of (data ?? []) as {
      os_client_id: string; from_status: string | null; to_status: string; changed_at: string;
    }[]) {
      // Ordered newest first, so the first row seen for a client is its latest.
      if (out.has(row.os_client_id)) continue;
      out.set(row.os_client_id, {
        status: row.to_status,
        at: row.changed_at,
        recorded: row.from_status === null,
        from: row.from_status,
      });
    }
  } catch {
    /* table missing or unreadable — the screen simply shows no date */
  }
  return out;
}
