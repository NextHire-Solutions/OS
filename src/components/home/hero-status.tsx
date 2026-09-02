"use client";

import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/format";
import type { HealthState } from "@/lib/connectors/types";

const HEADLINE_TONE: Record<HealthState, string> = {
  up: "text-foreground",
  degraded: "text-foreground",
  down: "text-foreground",
  unknown: "text-foreground",
  unconfigured: "text-foreground",
  checking: "text-foreground",
};

/*
 * The one hero per view, and it is deliberately TEXT.
 *
 * A launcher has no honest hero number. There is no defensible way to sum a
 * thread count, a client count and a bounce rate into one figure, and a
 * composite "97% health score" would be the first thing anyone stopped
 * trusting. So the hero is a sentence, with the exact breakdown beneath it.
 */
export function HeroStatus({
  headline,
  breakdown,
  state,
  generatedAt,
  refreshing,
  onRefresh,
}: {
  headline: string;
  breakdown: string;
  state: HealthState;
  generatedAt: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div aria-live="polite">
        <h1 className={cn("text-[22px] font-semibold leading-tight tracking-[-0.01em]", HEADLINE_TONE[state])}>
          {headline}
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">{breakdown}</p>
      </div>

      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span className="tnum">Checked {relativeTime(generatedAt)}</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh all statuses"
          className={cn(
            "flex size-7 items-center justify-center rounded-md border border-border bg-surface",
            "transition-colors duration-[120ms] hover:bg-hover-surface disabled:opacity-60",
          )}
        >
          <RefreshCw className={cn("size-3.5", refreshing && "cc-spin")} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
