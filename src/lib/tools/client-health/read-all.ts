/*
 * Every row of a Client Health read, page by page (Nov 2026).
 *
 * Supabase returns at most 1,000 rows per request whatever the query asks for, silently. bison_campaigns passed that
 * (1,244 rows on 25 Nov): the dashboard, the Interested-per-campaign step of the sync and onboarding's campaign
 * auto-link each saw an arbitrary 1,000 — the dashboard was missing 150 of the 312 campaigns assigned to active
 * clients. A read without a full, unique order also returns a different subset (or skips / repeats rows between
 * pages) whenever the table's physical order changes, as it does when the tables are copied into the Master Inbox
 * project. So: pass a query ordered by a unique key; `cap` stops reading after that many rows.
 */
export type PageResult = { data: unknown[] | null; error: { message: string } | null };

export async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<PageResult>,
  o: { size?: number; cap?: number } = {},
): Promise<{ data: T[]; error: { message: string } | null }> {
  const size = o.size ?? 1000;
  const cap = o.cap ?? Number.POSITIVE_INFINITY;
  const all: T[] = [];
  for (let from = 0; from < cap; from += size) {
    const to = Math.min(from + size, cap) - 1;
    const { data, error } = await page(from, to);
    if (error) return { data: all, error };
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < to - from + 1) break;
  }
  return { data: all, error: null };
}
