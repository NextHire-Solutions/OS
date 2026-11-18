/*
 * Marking what the platform no longer has (18 Nov).
 *
 * The inbox syncs upsert what EmailBison or Instantly lists, then archive the
 * rows they did not list: an inbox deleted upstream must stop showing. The
 * read of "what we still show" was a single select, and PostgREST stops a
 * select at 1,000 rows and says nothing. With 3,482 inboxes held, that read
 * saw 1,000 of them, none of them the 484 EmailBison had deleted, so those
 * stayed on the Inboxes page for weeks: 419 of them "Not connected", 61 of
 * them under the ALL tag that EmailBison showed as all connected. The guard
 * below was blind too, because it compared the walk against that same 1,000.
 *
 * So the live keys are read a page at a time, in a fixed order, and the guard
 * compares against all of them.
 *
 * Pure, with no `@/` imports, so it is tested directly against a fake that
 * caps every read at 1,000 rows the way the real database does.
 */

export interface ReconcileResult {
  /** Rows shown before this run. */
  live: number;
  /** Of those, the ones the platform did not list. */
  stale: number;
  archived: number;
  /** The walk listed less than half of what is shown: treated as a cut-short walk, so nothing is archived. */
  suspicious: boolean;
}

/**
 * @param seen every key the platform listed in this run.
 * @param readLive one page of the keys still shown (archived_at is null), in a
 *   FIXED order, `from` to `to` inclusive. Throwing or returning an error stops
 *   the reconcile before anything is archived.
 * @param archive marks these keys archived. Called in chunks, so a long list
 *   never becomes one oversized request.
 */
export async function reconcileArchive<K>({
  seen,
  readLive,
  archive,
  pageSize = 1000,
  chunk = 200,
}: {
  seen: ReadonlySet<K>;
  readLive: (from: number, to: number) => PromiseLike<{ data: K[] | null; error: unknown }>;
  archive: (keys: K[]) => PromiseLike<{ error: unknown }>;
  pageSize?: number;
  chunk?: number;
}): Promise<ReconcileResult> {
  const live: K[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await readLive(from, from + pageSize - 1);
    if (error) throw error;
    const page = data ?? [];
    live.push(...page);
    if (page.length < pageSize) break;
  }

  const stale = live.filter((k) => !seen.has(k));

  /*
   * THE GUARD. A walk that returns far less than we show is a cut-short walk,
   * not a mass deletion, and acting on it would archive a working estate on
   * the strength of one bad response. Real deletions come in ones and tens
   * (484 here was weeks of them), and the job runs every three hours.
   */
  const suspicious = seen.size < live.length * 0.5;

  let archived = 0;
  if (stale.length && !suspicious) {
    for (let i = 0; i < stale.length; i += chunk) {
      const part = stale.slice(i, i + chunk);
      const { error } = await archive(part);
      if (error) throw error;
      archived += part.length;
    }
  }

  return { live: live.length, stale: stale.length, archived, suspicious };
}
