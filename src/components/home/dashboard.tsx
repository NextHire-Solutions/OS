"use client";

import { useCallback, useEffect, useState } from "react";
import { Search, LogOut } from "lucide-react";
import type { ToolSnapshot } from "@/lib/connectors/types";
import { aggregate } from "@/lib/status/derive";
import { BrandMark } from "@/components/layout/brand-mark";
import { HeroStatus } from "./hero-status";
import { ToolCard } from "@/components/tool-card/tool-card";
import { CommandPalette } from "@/components/command/command-palette";

interface StatusPayload {
  snapshots: ToolSnapshot[];
  generatedAt: string;
}

/**
 * Column span for a card in a 6-wide track (3 cards per full row).
 *
 * Cards in a complete row take 2 of 6. A trailing partial row divides the full
 * width between whatever is left — so 5 tools render as 3 + 2, and 4 render as
 * 3 + 1 full-width. Nothing has to change when a sixth tool is added.
 */
function lastRowSpan(index: number, total: number): string {
  const remainder = total % 3;
  const inTrailingRow = remainder !== 0 && index >= total - remainder;

  if (!inTrailingRow) return "lg:col-span-2";
  return remainder === 1 ? "lg:col-span-6" : "lg:col-span-3";
}

/*
 * Owns polling and refresh.
 *
 * Seeded with server-rendered data so the first paint already has real numbers
 * and there is no client waterfall. After that:
 *   - poll every 60s, but NOT while the tab is hidden (a background tab must
 *     not keep five upstreams warm on someone's behalf)
 *   - refetch on visibilitychange, so returning to the tab is instant
 *   - never re-skeleton. Stale values stay on screen while refetching; a
 *     dashboard that visibly reloads itself trains you to ignore it.
 */
export function Dashboard({ initial }: { initial: StatusPayload }) {
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const load = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/tools/status${force ? "?force=1" : ""}`, {
        cache: "no-store",
      });

      // The session expired (or was revoked) while the tab sat open. Without
      // this the poll 401s every 60s forever and the page keeps showing
      // increasingly stale numbers with no hint that it has stopped updating.
      // A reload lets the proxy do the redirect to /login.
      if (res.status === 401) {
        window.location.reload();
        return;
      }

      if (!res.ok) return;
      const next = (await res.json()) as StatusPayload;
      setData(next);
    } catch {
      // Keep the last good payload on screen. A transient network blip should
      // not blank a page whose entire job is telling you what is reachable.
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);

    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const summary = aggregate(data.snapshots.map((s) => s.state));
  const pendingSetup = data.snapshots.reduce(
    (total, snapshot) =>
      total + snapshot.notes.filter((note) => note.level === "info" && note.envVar).length,
    0,
  );

  return (
    <div className="min-h-screen">
      <a
        href="#tools"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-[13px] focus:shadow-elevated focus:outline-2 focus:outline-ring"
      >
        Skip to tools
      </a>

      <header className="sticky top-0 z-30 h-14 border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-full max-w-[1200px] items-center gap-4 px-4 sm:px-6 lg:px-8">
          <BrandMark className="h-6 w-auto sm:h-7" />

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-keyshortcuts="Meta+K"
            className="ml-auto flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-hover-surface"
          >
            <Search className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Search or jump to…</span>
            <kbd className="ml-1 hidden rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] sm:inline">
              ⌘K
            </kbd>
          </button>

          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              aria-label="Sign out"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover-surface hover:text-foreground"
            >
              <LogOut className="size-4" aria-hidden="true" />
            </button>
          </form>
        </div>
      </header>

      <main
        id="tools"
        className="mx-auto max-w-[1200px] px-4 pb-16 pt-8 sm:px-6 lg:px-8"
      >
        <HeroStatus
          headline={summary.headline}
          breakdown={summary.breakdown}
          state={summary.state}
          generatedAt={data.generatedAt}
          refreshing={refreshing}
          onRefresh={() => void load(true)}
        />

        {/* A 6-column track so the final row can absorb the remainder instead
            of leaving a hole. With 5 tools that gives 3 cards + 2 wider cards,
            which reads as a deliberate layout rather than a missing card. */}
        <ul className="mt-6 grid list-none grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-6 lg:gap-5">
          {data.snapshots.map((snapshot, index) => (
            <ToolCard
              key={snapshot.id}
              snapshot={snapshot}
              index={index}
              className={lastRowSpan(index, data.snapshots.length)}
            />
          ))}
        </ul>

        <div className="mt-10 flex flex-col items-center gap-2 text-[12px] text-muted-foreground">
          <p>
            Press <kbd className="rounded border border-border bg-surface-sunken px-1 py-0.5 text-[10px]">⌘K</kbd> to
            search
            <span className="hidden sm:inline">
              {" "}· <kbd className="rounded border border-border bg-surface-sunken px-1 py-0.5 text-[10px]">⌘1</kbd>–
              <kbd className="rounded border border-border bg-surface-sunken px-1 py-0.5 text-[10px]">⌘5</kbd> to launch
            </span>
          </p>

          {/* Setup hints used to be a card in the grid, which put env var names
              on the main dashboard forever. They belong here: quiet, findable,
              and gone once everything is wired. */}
          {pendingSetup > 0 ? (
            <p className="text-[11px] text-muted-foreground/80">
              {pendingSetup} optional {pendingSetup === 1 ? "integration" : "integrations"} not
              connected — see the README to add tokens
            </p>
          ) : null}
        </div>
      </main>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        snapshots={data.snapshots}
        onRefresh={() => void load(true)}
      />
    </div>
  );
}
