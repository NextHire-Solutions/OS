/*
 * One conversation — the tool's own thread page, running here.
 *
 * A port of `app/(app)/inbox/[view]/[threadId]/page.tsx`, kept line-for-line
 * except that params arrive as props (the OS routes every screen through one
 * catch-all) and the imports point at the OS's copies of the same components.
 *
 * This is the screen that carries the features a hand-written inbox loses:
 * ThreadView brings the composer — attachments, forward, reply-all, the
 * template picker, the sender picker and AI draft generation — plus labelling,
 * snooze, subsequences and follow-up campaigns. ProspectPanel is another 960
 * lines of agent detail. None of it is re-specified here; it is the tool's.
 *
 * Three behaviours in the original are load-bearing and easy to lose in a
 * rewrite, so they are called out rather than left to be rediscovered:
 *
 *   `buildSuffix` threads ?f/?list/?page/?q through Back, Prev and Next. Drop
 *   it and every navigation dumps the user back into the unfiltered inbox —
 *   the SERHANT. list bug named in the original comment.
 *
 *   `seen: true` rides inside the same Promise.all as the loaders rather than
 *   running after them, so marking a thread read costs no extra wall-clock.
 *
 *   The per-loader timing logs stay. Twelve parallel loaders means the slowest
 *   one sets the page's speed, and without these you are guessing which.
 */

import { notFound } from "next/navigation";
import { TopBar } from "@/components/master-inbox/top-bar";
import { TabBar } from "@/components/master-inbox/tab-bar";
import { FilterBar } from "@/components/master-inbox/filter-bar";
import { ThreadList } from "@/components/master-inbox/thread-list";
import { ThreadView } from "@/components/master-inbox/thread-view";
import { ProspectPanel } from "@/components/master-inbox/prospect-panel";
import { RealtimeRefresher } from "@/components/master-inbox/realtime-refresher";
import { ClickRenderTiming } from "@/components/master-inbox/perf-timing";
import { requireSession } from "@/lib/auth/workspace";
import { loadThreads } from "@/lib/tools/master-inbox/inbox/threads";
import { loadThreadDetail } from "@/lib/tools/master-inbox/inbox/thread-detail";
import { loadViews, loadViewBySlug, loadViewCounts } from "@/lib/tools/master-inbox/inbox/views";
import { loadLabels } from "@/lib/tools/master-inbox/inbox/labels";
import { loadChannels } from "@/lib/tools/master-inbox/inbox/channels";
import { loadCampaigns } from "@/lib/tools/master-inbox/inbox/campaigns";
import { loadClients } from "@/lib/tools/master-inbox/inbox/clients";
import { loadLists } from "@/lib/tools/master-inbox/inbox/lists";
import { loadChannelEmailMap } from "@/lib/tools/master-inbox/inbox/channel-emails";
import { decodeFilter, type FilterState } from "@/lib/tools/master-inbox/inbox/filters";
import { createAdminSupabase } from "@/lib/supabase/admin";


// Preserve the active list / filter / page / search across the
// thread-detail Back, Prev, and Next links. Without this the next
// thread's URL would drop the ?list=… (and ?f=…) params and dump
// the user back to the unfiltered view — the exact behaviour
// flagged in the SERHANT. list bug report.
function buildSuffix(
  f: string | undefined,
  list: string | undefined,
  page: string | undefined,
  q: string | undefined,
): string {
  const params = new URLSearchParams();
  if (f) params.set("f", f);
  if (list) params.set("list", list);
  if (page) params.set("page", page);
  if (q) params.set("q", q);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export interface ThreadDetailProps {
  view: string;
  threadId: string;
  f?: string;
  list?: string;
  page?: string;
  q?: string;
}

export async function ThreadDetail({ view, threadId, f, list, page, q }: ThreadDetailProps) {

  // Server-side timing instrumentation — appears in Railway logs as
  // `[thread-detail t=…ms] step` so we can identify which step actually
  // dominates wall-clock time per click.
  const t0 = Date.now();
  const ts = (label: string) =>
    console.log(`[thread-detail t=${Date.now() - t0}ms] ${label}`);

  ts("start");
  const session = await requireSession();
  ts("after requireSession");
  const filterFromUrl: FilterState | null = f ? decodeFilter(f) : null;
  const pageNum = Math.max(1, Number(page ?? "1") || 1);
  const searchQuery = q?.trim() || null;

  // Per-loader timing. Wrap each promise so we know wall-clock duration
  // of each parallel branch. Reveals which one is the slowest (bounds
  // Promise.all's total time).
  const timed = <T,>(name: string, p: Promise<T>): Promise<T> => {
    const start = Date.now();
    return p.then((v) => {
      console.log(`[thread-detail t=${Date.now() - t0}ms]   loader '${name}' done in ${Date.now() - start}ms`);
      return v;
    });
  };

  const [threadPage, detail, views, viewCounts, labels, channels, campaigns, clients, lists, currentView, emailByChannelId] = await Promise.all([
    timed("loadThreads", loadThreads(session.activeWorkspace.id, view, filterFromUrl, list ?? null, pageNum, searchQuery)),
    timed("loadThreadDetail", loadThreadDetail(session.activeWorkspace.id, threadId)),
    timed("loadViews", loadViews(session.activeWorkspace.id)),
    timed("loadViewCounts", loadViewCounts(session.activeWorkspace.id, list ?? null)),
    timed("loadLabels", loadLabels(session.activeWorkspace.id)),
    timed("loadChannels", loadChannels(session.activeWorkspace.id)),
    timed("loadCampaigns", loadCampaigns(session.activeWorkspace.id)),
    timed("loadClients", loadClients(session.activeWorkspace.id)),
    timed("loadLists", loadLists(session.activeWorkspace.id)),
    timed("loadViewBySlug", loadViewBySlug(session.activeWorkspace.id, view)),
    // Was a serial post-render outbound-messages scan on every open;
    // now a parallel, workspace-cached loader (see channel-emails.ts).
    timed("loadChannelEmailMap", loadChannelEmailMap(session.activeWorkspace.id)),
    timed(
      "seen=true update",
      Promise.resolve(
        createAdminSupabase()
          .from("threads")
          .update({ seen: true })
          .eq("id", threadId)
          .eq("workspace_id", session.activeWorkspace.id),
      ).then(() => undefined),
    ),
  ]);
  ts("after Promise.all (all loaders)");
  if (!detail) notFound();
  ts("ready to render");

  const initialFilter: FilterState =
    filterFromUrl ?? {
      rows:
        (currentView?.filter_json as { rows?: import("@/lib/inbox/filters").FilterRow[] } | undefined)
          ?.rows ?? [],
    };

  return (
    /*
     * `mi-theme` re-points Tailwind's semantic tokens at the mockup's palette
     * for everything inside it — see src/app/inbox-theme.css. Scoped here
     * rather than applied globally so the rest of the OS, which is already
     * drawn in the design's own classes, is untouched.
     */
    <div className="mi-theme">
      <TopBar />
      <TabBar views={views} activeSlug={view} labels={labels} viewCounts={viewCounts} />
      <FilterBar
        initialFilter={initialFilter}
        labels={labels}
        channels={channels}
        campaigns={campaigns}
        clients={clients}
        currentViewId={currentView?.id ?? null}
        currentViewName={currentView?.name ?? null}
      />
      <div className="flex-1 min-h-0 flex">
        <aside className="w-[300px] shrink-0 border-r flex flex-col overflow-hidden">
          <div className="px-4 h-10 flex items-center text-sm font-medium border-b">
            All messages
          </div>
          <ThreadList
            threads={threadPage.rows}
            basePath={`/inbox/${view}`}
            activeId={threadId}
            compact
            labels={labels}
            lists={lists}
            total={threadPage.total}
            page={threadPage.page}
            pageSize={threadPage.pageSize}
            view={view}
          />
        </aside>
        <ThreadView
          detail={detail}
          availableLabels={labels}
          channels={channels
            .filter(
              (c): c is typeof c & {
                provider: "instantly" | "emailbison" | "unipile";
                display_name: string;
              } => Boolean(c.provider) && Boolean(c.display_name),
            )
            .map((c) => ({
              id: c.id,
              provider: c.provider,
              display_name: c.display_name,
              instantly_account_id: c.instantly_account_id ?? null,
              email:
                c.instantly_account_id ??
                c.external_account_id ??
                emailByChannelId[c.id] ??
                null,
            }))}
          backHref={`/inbox/${view}${buildSuffix(f, list, page, q)}`}
          prevThreadHref={(() => {
            const idx = threadPage.rows.findIndex((t) => t.id === threadId);
            const prev = idx > 0 ? threadPage.rows[idx - 1] : null;
            return prev ? `/inbox/${view}/${prev.id}${buildSuffix(f, list, page, q)}` : null;
          })()}
          nextThreadHref={(() => {
            const idx = threadPage.rows.findIndex((t) => t.id === threadId);
            const next = idx >= 0 && idx < threadPage.rows.length - 1 ? threadPage.rows[idx + 1] : null;
            return next ? `/inbox/${view}/${next.id}${buildSuffix(f, list, page, q)}` : null;
          })()}
        />
        <ProspectPanel detail={detail} />
      </div>
      <RealtimeRefresher workspaceId={session.activeWorkspace.id} />
      <ClickRenderTiming threadId={threadId} />
    </div>
  );
}
