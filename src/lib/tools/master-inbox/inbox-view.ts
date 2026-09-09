import "server-only";

import { loadThreads, THREAD_PAGE_SIZE, type ThreadRow } from "./inbox/threads";
import { loadThreadDetail, type ThreadDetail } from "./inbox/thread-detail";
import { loadViews, loadViewCounts, type CustomView, type ViewCount } from "./inbox/views";
import { workspaceId } from "./supabase";

/*
 * Master Inbox — the staff inbox, read from its own database.
 *
 * `loadThreads` and `loadThreadDetail` are the tool's own files, copied
 * unchanged. That matters more here than anywhere else in the workspace,
 * because that query carries several hard-won corrections that are invisible
 * unless you already know about them. From its own comments:
 *
 *   the page size is 50, not 100, because the list is not virtualised and
 *   every row is serialised, rendered and hydrated on every thread switch;
 *
 *   label, list, search and "open responses" filters are resolved into
 *   in-memory id sets rather than `.in("id", …)`, because thousands of UUIDs
 *   in a URL overflow Node's 16 KB header cap — and when it overflows, fetch
 *   throws and the page renders EMPTY with no error. That was a real bug.
 *
 * Reimplementing this would have reintroduced both. So only the Supabase
 * client factory was swapped; every line of the query is theirs.
 *
 * Strictly read-only. Writes go through Master Inbox's own API, because
 * labelling a thread fires a database trigger that creates a pipeline row in
 * the client's LIVE portal. See MASTER-INBOX-AUDIT.md.
 */

export type { ThreadRow, ThreadDetail, CustomView, ViewCount };
export { THREAD_PAGE_SIZE };

/** The four views the tool treats as built in. */
export const SYSTEM_VIEWS = [
  { slug: "all-email", label: "All Email" },
  { slug: "archive", label: "Archive" },
  { slug: "spam", label: "Spam" },
  { slug: "trash", label: "Trash" },
] as const;

export interface InboxQuery {
  view: string;
  page: number;
  q: string;
}

export interface InboxData {
  query: InboxQuery;
  /**
   * The server's clock at load.
   *
   * Sent rather than read in the browser because the list renders relative
   * times ("2:14 PM" for today, "Sep 8" for older). `Date.now()` on both sides
   * of hydration is two different instants, and `toLocaleTimeString` on both
   * sides is two different timezones — either one renders different text and
   * React tears the tree down.
   */
  now: string;
  threads: ThreadRow[];
  total: number;
  page: number;
  pageSize: number;
  views: CustomView[];
  /** Keyed by view slug, as the tool returns it. */
  counts: Record<string, ViewCount>;
  error: string | null;
}

/** Parses request params into a query, clamping anything hostile. */
export function parseInboxQuery(params: URLSearchParams): InboxQuery {
  const page = Number(params.get("page") ?? 1);
  return {
    // A slug, not free text — it reaches a database lookup.
    view: (params.get("view") ?? "all-email").replace(/[^a-z0-9-]/gi, "").slice(0, 60) || "all-email",
    page: Number.isFinite(page) ? Math.min(Math.max(1, Math.floor(page)), 10_000) : 1,
    q: (params.get("q") ?? "").trim().slice(0, 120),
  };
}

export async function getInbox(query: InboxQuery): Promise<InboxData> {
  const empty = {
    query,
    now: new Date().toISOString(),
    threads: [],
    total: 0,
    page: query.page,
    pageSize: THREAD_PAGE_SIZE,
    views: [] as CustomView[],
    counts: {} as Record<string, ViewCount>,
  };

  try {
    const ws = await workspaceId();

    // The views and their counts are needed by the rail on every load; the
    // tool memoises both per request, so asking for them here is one round
    // trip each rather than one per view.
    const [list, views, counts] = await Promise.all([
      loadThreads(ws, query.view, null, null, query.page, query.q || null),
      loadViews(ws),
      loadViewCounts(ws),
    ]);

    return {
      ...empty,
      threads: list.rows,
      total: list.total,
      page: list.page,
      pageSize: list.pageSize,
      views,
      counts,
      error: null,
    };
  } catch (error) {
    // A failure costs this screen, never the workspace — and it says what
    // happened rather than rendering an empty inbox, which is the one thing an
    // inbox must never do ambiguously.
    return {
      ...empty,
      error: error instanceof Error ? error.message : "Master Inbox is unreachable",
    };
  }
}

export interface ThreadResult {
  detail: ThreadDetail | null;
  error: string | null;
}

export async function getThread(threadId: string): Promise<ThreadResult> {
  try {
    const ws = await workspaceId();
    return { detail: await loadThreadDetail(ws, threadId), error: null };
  } catch (error) {
    return {
      detail: null,
      error: error instanceof Error ? error.message : "That conversation could not be loaded",
    };
  }
}
