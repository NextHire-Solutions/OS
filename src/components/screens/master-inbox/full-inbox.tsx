import { TopBar } from "@/components/master-inbox/top-bar";
import { MockupTabs } from "./mockup/tabs";
import { MockupThreadList } from "./mockup/list";
import { FilterBar } from "@/components/master-inbox/filter-bar";
import { EmptyInbox } from "@/components/master-inbox/empty-state";
import { RealtimeRefresher } from "@/components/master-inbox/realtime-refresher";
import { requireSession } from "@/lib/auth/workspace";
import { loadThreads } from "@/lib/tools/master-inbox/inbox/threads";
import { loadViews, loadViewBySlug, loadViewCounts } from "@/lib/tools/master-inbox/inbox/views";
import { loadLabels } from "@/lib/tools/master-inbox/inbox/labels";
import { loadChannels } from "@/lib/tools/master-inbox/inbox/channels";
import { loadCampaigns } from "@/lib/tools/master-inbox/inbox/campaigns";
import { loadClients } from "@/lib/tools/master-inbox/inbox/clients";
import { decodeFilter, type FilterRow, type FilterState } from "@/lib/tools/master-inbox/inbox/filters";

/*
 * The Master Inbox, assembled from the tool's own components.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PORT AND NOT A REWRITE
 *
 * The first version of this screen was written from scratch against the
 * mockup's stylesheet. It looked right and it was missing most of the product:
 * no attachments, no forward, no reply-all, no templates, no sender picker, no
 * AI draft, no snooze, no prospect panel, no filter builder. Every one of those
 * is a component the tool already has and every one would have had to be
 * rediscovered, re-specified and re-tested.
 *
 * So this file is the tool's `app/(app)/inbox/[view]/page.tsx`, kept as close
 * to line-for-line as the two differences below allow. The behaviour is not
 * being reinterpreted; it is being run.
 *
 * ---------------------------------------------------------------------------
 * THE TWO DIFFERENCES, AND WHY EACH IS FORCED
 *
 *   1. It takes `view`, `f`, `list`, `page` and `q` as PROPS rather than
 *      reading them from route params. The OS routes every screen through one
 *      catch-all (`app/[[...slug]]/page.tsx`) so a pasted link paints the right
 *      screen on the first render with no client-side redirect. The values are
 *      the same values; only who parses them moves.
 *
 *   2. Nine loaders run in one `Promise.all`, exactly as the tool does it.
 *      Worth stating because it is load-bearing rather than tidy: run in
 *      sequence these are nine round-trips to Supabase, and the inbox is the
 *      screen people keep open all day. The tool learned this the expensive
 *      way — its `realtime-refresher` carries a comment about "the multi-second
 *      freezes operators reported" from re-running exactly these nine.
 *
 * Everything else — the component tree, the props, the empty-state condition,
 * the filter fallback to the saved view — is the tool's.
 */

export interface FullInboxProps {
  view: string;
  f?: string;
  list?: string;
  page?: string;
  q?: string;
}

export async function FullInbox({ view, f, list, page, q }: FullInboxProps) {
  const session = await requireSession();
  const filterFromUrl: FilterState | null = f ? decodeFilter(f) : null;
  const pageNum = Math.max(1, Number(page ?? "1") || 1);
  const searchQuery = q?.trim() || null;

  const [threadPage, views, viewCounts, labels, channels, campaigns, clients, currentView] =
    await Promise.all([
      loadThreads(session.activeWorkspace.id, view, filterFromUrl, list ?? null, pageNum, searchQuery),
      loadViews(session.activeWorkspace.id),
      loadViewCounts(session.activeWorkspace.id, list ?? null),
      loadLabels(session.activeWorkspace.id),
      loadChannels(session.activeWorkspace.id),
      loadCampaigns(session.activeWorkspace.id),
      loadClients(session.activeWorkspace.id),
      loadViewBySlug(session.activeWorkspace.id, view),
    ]);

  // A view's saved filter is the starting point when the URL carries none —
  // otherwise opening a saved view would show it unfiltered, which reads as
  // the view being broken rather than empty.
  const initialFilter: FilterState =
    filterFromUrl ?? {
      rows: (currentView?.filter_json as { rows?: FilterRow[] } | undefined)?.rows ?? [],
    };

  /*
   * The server's clock, sent to the list so its timestamps agree between the
   * server render and the client hydration. Reading Date.now() inside the row
   * gives two different answers and React discards the whole list.
   */
  const now = Date.now();

  return (
    /*
     * `mi-theme` re-points Tailwind's semantic tokens at the mockup's palette
     * for the parts of this screen that are still the tool's components — the
     * filter bar and, once a conversation is open, the composer and prospect
     * panel. See src/app/inbox-theme.css.
     */
    <div className="mi-theme">
      <TopBar />

      {/*
       * The design's tabs and list, the tool's data.
       *
       * The tool's own TabBar and ThreadList are Tailwind components that look
       * like the tool. The approved mockup draws both differently — pill tabs
       * with a count, and a row of fixed columns rather than one long preview
       * line — and that is markup, not colour, so no token remapping reaches
       * it.
       *
       * What is NOT swapped: everything below the list. FilterBar is the tool's
       * 921-line filter builder, and opening a conversation lands in the tool's
       * ThreadView with its composer, attachments, forward, templates, AI
       * drafts, snooze, subsequences and prospect panel. The mockup does not
       * draw any of those, so re-doing them would only lose features.
       */}
      <MockupTabs
        views={views.map((v) => ({ id: v.id, slug: v.slug, name: v.name }))}
        activeSlug={view}
        counts={viewCounts}
      />

      <div className="mi-filter">
        <FilterBar
          initialFilter={initialFilter}
          labels={labels}
          channels={channels}
          campaigns={campaigns}
          clients={clients}
          currentViewId={currentView?.id ?? null}
          currentViewName={currentView?.name ?? null}
        />
      </div>

      {threadPage.rows.length === 0 && threadPage.total === 0 ? (
        <EmptyInbox view={view} />
      ) : (
        <MockupThreadList
          threads={threadPage.rows}
          view={view}
          total={threadPage.total}
          page={threadPage.page}
          pageSize={threadPage.pageSize}
          now={now}
        />
      )}

      <RealtimeRefresher workspaceId={session.activeWorkspace.id} />
    </div>
  );
}
