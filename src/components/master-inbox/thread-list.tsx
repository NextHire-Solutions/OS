"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Mail, Paperclip, ChevronLeft, ChevronRight } from "lucide-react";
import { Checkbox } from "@/components/mi-ui/checkbox";
import { LabelChip } from "@/components/master-inbox/label-chip";
import { BulkActionsBar } from "@/components/master-inbox/bulk-actions-bar";
import { RelativeTime } from "@/components/master-inbox/relative-time";
import { cn } from "@/lib/tools/master-inbox/utils";
import type { ThreadRow } from "@/lib/tools/master-inbox/inbox/threads";
import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels-shared";
import type { ListRow } from "@/lib/tools/master-inbox/inbox/lists-shared";

// Preserve the thread-list scroll position across navigations (open a
// thread → page re-mounts → list defaulted to scrollTop=0). Persist per
// basePath so different views don't collide.
function useScrollMemory(basePath: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = `threadlist-scroll:${basePath}`;
    const stored = sessionStorage.getItem(key);
    const el = ref.current;
    if (el && stored) {
      const n = Number(stored);
      if (Number.isFinite(n)) el.scrollTop = n;
    }
    const onScroll = () => {
      if (ref.current) sessionStorage.setItem(key, String(ref.current.scrollTop));
    };
    el?.addEventListener("scroll", onScroll, { passive: true });
    return () => el?.removeEventListener("scroll", onScroll);
  }, [basePath]);
  return ref;
}

// Kept as a stub for any straggler call sites — the live thread-list
// rows now use the <RelativeTime /> client component to avoid hydration
// mismatches (Node default locale != browser default locale = React #418
// + full re-render of the list every click).
function relativeTime(ts: string | null): string {
  return ts ?? "";
}

export function ThreadList({
  threads,
  basePath,
  activeId,
  compact = false,
  labels = [],
  lists = [],
  total,
  page,
  pageSize,
  view,
}: {
  threads: ThreadRow[];
  basePath: string;
  activeId?: string;
  compact?: boolean;
  labels?: LabelRow[];
  lists?: ListRow[];
  total?: number;
  page?: number;
  pageSize?: number;
  // Current view slug, forwarded to BulkActionsBar so the trash view
  // can opt in to the "Delete forever" action.
  view?: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Track thread ids the user just opened. Optimistic so the blue dot
  // disappears on click without waiting for the server round-trip.
  const [optimisticSeen, setOptimisticSeen] = useState<Set<string>>(new Set());
  function isSeen(t: ThreadRow): boolean {
    return t.seen || optimisticSeen.has(t.id) || t.id === activeId;
  }
  function markOpened(id: string) {
    setOptimisticSeen((cur) => {
      if (cur.has(id)) return cur;
      const next = new Set(cur);
      next.add(id);
      return next;
    });
  }

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll(v: boolean) {
    if (v) setSelected(new Set(threads.map((t) => t.id)));
    else setSelected(new Set());
  }

  const selectedArray = Array.from(selected);
  const allSelected = selected.size > 0 && selected.size === threads.length;
  const scrollRef = useScrollMemory(basePath);

  // Carry the active search (?q=) and list (?list=) onto thread links so
  // opening a thread from search results keeps the side list filtered to
  // the same matches.
  const navParams = useSearchParams();
  const carry = (() => {
    const p = new URLSearchParams();
    const q = navParams?.get("q");
    const list = navParams?.get("list");
    if (q) p.set("q", q);
    if (list) p.set("list", list);
    const s = p.toString();
    return s ? `?${s}` : "";
  })();
  const threadHref = (id: string) => `${basePath}/${id}${carry}`;

  if (compact) {
    return (
      <>
        <div className="h-9 shrink-0 border-b flex items-center px-3 text-[11px] text-muted-foreground gap-2">
          <CountAndRange total={total} page={page} pageSize={pageSize} shown={threads.length} />
          <div className="flex-1" />
          <PaginationControls basePath={basePath} page={page} pageSize={pageSize} total={total} compact />
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <ul>
          {threads.map((t) => {
            const active = t.id === activeId;
            const href = threadHref(t.id);
            // Stop click propagation on the checkbox so the row's link
            // doesn't navigate when toggling selection.
            const eatClick = (e: React.MouseEvent) => {
              e.stopPropagation();
              e.preventDefault();
            };
            // Perf instrumentation: record the moment the user clicks a
            // thread; the destination page reads it and logs the total
            // click-to-render time to the browser console.
            const onLinkClick = () => {
              markOpened(t.id);
              try {
                sessionStorage.setItem(
                  "mi:lastClickAt",
                  String(performance.now()),
                );
                sessionStorage.setItem("mi:lastClickTarget", t.id);
              } catch {
                /* sessionStorage can be disabled in private mode */
              }
            };
            const unread = !isSeen(t);
            return (
              <li key={t.id} className="border-b">
                <Link
                  href={href}
                  onClick={onLinkClick}
                  className={cn(
                    "block px-3 py-3 transition-colors",
                    // Gmail-style read/unread contrast: unread rows keep
                    // the canvas white + bold weight; read rows get a
                    // subtle gray wash so the eye glides over them.
                    // Selected (active) wins over both.
                    // Read rows wash to a clearly visible gray
                    // (zinc-200 in light mode). zinc-100 still felt
                    // too close to white per the customer; bumped a
                    // step darker for distinct read-vs-unread at a
                    // glance.
                    active
                      ? "bg-accent"
                      : unread
                        ? "bg-background hover:bg-accent/40"
                        : "bg-zinc-200/90 hover:bg-accent/40 dark:bg-zinc-800/60",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <div
                      className="flex items-center gap-1.5 pt-0.5"
                      onClick={eatClick}
                    >
                      <UnseenDot seen={isSeen(t)} />
                      <Checkbox
                        checked={selected.has(t.id)}
                        onCheckedChange={() => toggle(t.id)}
                      />
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col gap-1 text-[13px]">
                      <div className="flex items-center gap-2">
                        <ChannelIcon provider={t.channel_provider} />
                        {/* Gmail-style typography: unread rows are
                            bold (sender + subject), read rows are
                            normal-weight. Combined with the
                            zinc-200/90 background on read rows this
                            gives the same at-a-glance contrast Gmail
                            uses. */}
                        <span
                          className={cn(
                            "truncate flex-1",
                            unread ? "font-bold text-foreground" : "font-normal text-foreground/80",
                          )}
                        >
                          {t.lead_full_name || t.lead_email || "Unknown"}
                        </span>
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          <RelativeTime iso={t.last_message_at} />
                        </span>
                      </div>
                      <div
                        className={cn(
                          "truncate",
                          unread ? "font-bold text-foreground" : "font-normal text-foreground/80",
                        )}
                      >
                        {t.subject || "(no subject)"}
                      </div>
                      <div className="truncate text-muted-foreground">
                        {t.last_message_preview}
                      </div>
                      {(t.source_provider || t.client_name || t.campaign_name || t.labels.length > 0) ? (
                        <div className="flex items-center gap-1 flex-wrap">
                          <SourceBadge source={t.source_provider} />
                          <ClientChip name={t.client_name} slug={t.client_slug} />
                          <CampaignChip name={t.campaign_name} />
                          {t.labels.slice(0, 2).map((l) => (
                            <LabelChip key={l.name} name={l.name} color={l.color} />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Sticky select-all + bulk bar. Always rendered so users can select
          all from here; expands with action buttons when something's picked. */}
      <div className="h-11 shrink-0 border-b bg-background flex items-center px-3 sticky top-0 z-10">
        <Checkbox
          checked={allSelected}
          onCheckedChange={selectAll}
          className="ml-1"
          aria-label="Select all"
        />
        {selectedArray.length > 0 ? (
          <BulkActionsBar
            selected={selectedArray}
            onClear={() => setSelected(new Set())}
            labels={labels}
            lists={lists}
            view={view}
          />
        ) : (
          <CountAndRange
            total={total}
            page={page}
            pageSize={pageSize}
            shown={threads.length}
          />
        )}
        <div className="flex-1" />
        <PaginationControls basePath={basePath} page={page} pageSize={pageSize} total={total} />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <ul>
          {threads.map((t) => (
            <li
              key={t.id}
              className={cn(
                "flex items-center gap-3 px-4 h-12 border-b transition-colors hover:bg-accent/40",
                // Read rows get a subtle gray wash; unread stay on the
                // bright canvas. Same Gmail-style contrast pattern as the
                // multi-line view above.
                isSeen(t)
                  ? "bg-zinc-200/90 dark:bg-zinc-800/60"
                  : "bg-background",
              )}
            >
              <div className="flex items-center gap-1.5">
                <UnseenDot seen={isSeen(t)} />
                <Checkbox
                  checked={selected.has(t.id)}
                  onCheckedChange={() => toggle(t.id)}
                />
              </div>
              <Link
                href={threadHref(t.id)}
                onClick={() => markOpened(t.id)}
                className="flex items-center gap-3 flex-1 min-w-0"
              >
                <ChannelIcon provider={t.channel_provider} />
                <div
                  className={cn(
                    "w-40 shrink-0 truncate text-[13px]",
                    !isSeen(t) ? "font-bold text-foreground" : "font-normal text-foreground/80",
                  )}
                >
                  {t.lead_full_name || t.lead_email || "Unknown"}
                </div>
                {(t.source_provider || t.client_name || t.campaign_name || t.labels.length > 0) ? (
                  <div className="flex items-center gap-1 shrink-0">
                    <SourceBadge source={t.source_provider} />
                    <ClientChip name={t.client_name} slug={t.client_slug} />
                    <CampaignChip name={t.campaign_name} />
                    {t.labels.slice(0, 2).map((l) => (
                      <LabelChip key={l.name} name={l.name} color={l.color} />
                    ))}
                  </div>
                ) : null}
                <Paperclip className="size-3.5 text-muted-foreground shrink-0 opacity-0" />
                <div
                  className={cn(
                    "text-[13px] shrink-0 max-w-[28%] truncate",
                    !isSeen(t) ? "font-bold text-foreground" : "font-normal text-foreground/80",
                  )}
                >
                  {t.subject || "(no subject)"}
                </div>
                <div className="min-w-0 flex-1 text-[13px] text-muted-foreground truncate">
                  {t.last_message_preview}
                </div>
                <div className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  <RelativeTime iso={t.last_message_at} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function UnseenDot({ seen }: { seen: boolean }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full shrink-0",
        seen ? "bg-transparent" : "bg-blue-500",
      )}
      aria-hidden
    />
  );
}

function ChannelIcon({ provider: _provider }: { provider: ThreadRow["channel_provider"] }) {
  return (
    <div className="size-6 rounded flex items-center justify-center shrink-0 bg-zinc-100 text-zinc-600">
      <Mail className="size-3.5" strokeWidth={2} />
    </div>
  );
}

// Per-thread badge showing which outreach platform the reply came from.
// Tiny purple/indigo chips, distinct from label chips so they don't blend in.
function SourceBadge({ source }: { source: ThreadRow["source_provider"] }) {
  if (!source) return null;
  const label = source === "instantly" ? "Instantly" : "EmailBison";
  const classes =
    source === "instantly"
      ? "bg-indigo-50 text-indigo-700 border-indigo-200"
      : "bg-violet-50 text-violet-700 border-violet-200";
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap uppercase tracking-wide",
        classes,
      )}
    >
      {label}
    </span>
  );
}

// Client chip — derived from the EmailBison/Instantly campaign name at sync
// time. Renders the BrokerStaffer client this thread belongs to. "Unknown" gets a
// muted treatment so real clients pop visually.
function ClientChip({ name, slug }: { name: string | null; slug: string | null }) {
  if (!name) return null;
  const isUnknown = slug === "unknown";
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap",
        isUnknown
          ? "bg-zinc-50 text-zinc-500 border-zinc-200"
          : "bg-amber-50 text-amber-800 border-amber-200",
      )}
      title={`Client: ${name}`}
    >
      {name}
    </span>
  );
}

// Raw campaign name as stored on the provider. Long, so we truncate to a
// reasonable display width and rely on the title tooltip for the full name.
function CampaignChip({ name }: { name: string | null }) {
  if (!name) return null;
  const truncated = name.length > 32 ? name.slice(0, 30) + "…" : name;
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap bg-sky-50 text-sky-700 border-sky-200 max-w-[14rem] truncate"
      title={`Campaign: ${name}`}
    >
      {truncated}
    </span>
  );
}

// Header label — "Showing 1-100 of 4,373" / "100 conversations" / etc.
function CountAndRange({
  total,
  page,
  pageSize,
  shown,
}: {
  total?: number;
  page?: number;
  pageSize?: number;
  shown: number;
}) {
  if (typeof total !== "number") {
    return (
      <span className="ml-3 text-xs text-muted-foreground">
        {shown} {shown === 1 ? "conversation" : "conversations"}
      </span>
    );
  }
  const p = page ?? 1;
  const size = pageSize ?? shown;
  const start = total === 0 ? 0 : (p - 1) * size + 1;
  const end = Math.min(p * size, total);
  // Force en-US grouping so server (Node, en-US default) and client
  // (browser default — could be en-IN with 1,23,456 grouping) produce
  // the same string. Avoids React hydration mismatch on every list
  // render.
  const fmt = (n: number) => n.toLocaleString("en-US");
  return (
    <span className="ml-3 text-xs text-muted-foreground tabular-nums">
      {total === 0
        ? "0 conversations"
        : `${fmt(start)}–${fmt(end)} of ${fmt(total)}`}
    </span>
  );
}

// Prev/Next buttons that preserve every other query param (filter, list,
// etc.) and just bump the `page` parameter.
function PaginationControls({
  basePath,
  page,
  pageSize,
  total,
  compact = false,
}: {
  basePath: string;
  page?: number;
  pageSize?: number;
  total?: number;
  compact?: boolean;
}) {
  void basePath;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (typeof total !== "number" || typeof pageSize !== "number") return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const cur = page ?? 1;
  if (totalPages <= 1) return null;

  function href(targetPage: number): string {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    if (targetPage <= 1) next.delete("page");
    else next.set("page", String(targetPage));
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  const prevDisabled = cur <= 1;
  const nextDisabled = cur >= totalPages;
  const size = compact ? "size-6" : "size-7";

  return (
    <div className="flex items-center gap-1 mr-1">
      <span className={cn("text-xs text-muted-foreground tabular-nums mr-1", compact && "text-[11px]")}>
        Page {cur} / {totalPages}
      </span>
      <Link
        href={prevDisabled ? "#" : href(cur - 1)}
        aria-label="Previous page"
        aria-disabled={prevDisabled}
        tabIndex={prevDisabled ? -1 : 0}
        className={cn(
          size,
          "rounded-md inline-flex items-center justify-center border bg-background text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
          prevDisabled && "opacity-40 pointer-events-none",
        )}
      >
        <ChevronLeft className="size-3.5" />
      </Link>
      <Link
        href={nextDisabled ? "#" : href(cur + 1)}
        aria-label="Next page"
        aria-disabled={nextDisabled}
        tabIndex={nextDisabled ? -1 : 0}
        className={cn(
          size,
          "rounded-md inline-flex items-center justify-center border bg-background text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
          nextDisabled && "opacity-40 pointer-events-none",
        )}
      >
        <ChevronRight className="size-3.5" />
      </Link>
    </div>
  );
}
