"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Filter, Loader2 } from "lucide-react";
import { Button } from "@/components/mi-ui/button";
import { FilterBuilder } from "@/components/master-inbox/filter-builder";
import { useDismiss } from "@/components/master-inbox/use-dismiss";
import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels-shared";
import type { ChannelRow } from "@/lib/tools/master-inbox/inbox/channels-shared";
import type { CampaignOption } from "@/lib/tools/master-inbox/inbox/campaigns";
import type { ClientOption } from "@/lib/tools/master-inbox/inbox/clients";
import { countActiveRows, type FilterState } from "@/lib/tools/master-inbox/inbox/filters";

export function FilterBar({
  initialFilter = { rows: [] },
  labels = [],
  channels = [],
  campaigns = [],
  clients = [],
  currentViewId = null,
  currentViewName = null,
}: {
  initialFilter?: FilterState;
  labels?: LabelRow[];
  channels?: ChannelRow[];
  campaigns?: CampaignOption[];
  clients?: ClientOption[];
  currentViewId?: string | null;
  currentViewName?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const activeCount = countActiveRows(initialFilter);

  /*
   * The filter box closes on a click outside it and on Escape (12 Oct).
   *
   * It only closed from the Filters button it was opened with, so it sat over
   * the first rows of the list until you went back for that button. Closing
   * loses nothing: FilterBuilder keeps its draft rows while it is hidden, so
   * reopening shows the filter you were building.
   *
   * "Inside" is the box and its button — not the whole bar, whose empty
   * stretch beside the button is exactly where someone clicks to get out.
   * The menus the box opens are handled by the hook; see use-dismiss.ts.
   */
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useDismiss(
    open,
    () => setOpen(false),
    (target) => Boolean(panelRef.current?.contains(target) || toggleRef.current?.contains(target)),
  );

  /*
   * `mi-filterbar` / `mi-filterbar-row` are hooks for mi-inbox.css, which fits
   * this bar into the design's filter band. They carry no style of their own.
   */
  return (
    <div className="relative mi-filterbar">
      <div className="mi-filterbar-row h-11 shrink-0 border-b bg-background flex items-center px-3 gap-2">
        <button
          type="button"
          onClick={() => startTransition(() => router.refresh())}
          disabled={refreshing}
          aria-label="Refresh"
          title="Refresh"
          className="size-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="size-[15px] animate-spin" strokeWidth={2} />
          ) : (
            <RefreshCw className="size-[15px]" strokeWidth={2} />
          )}
        </button>
        <Button
          ref={toggleRef}
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-[13px] font-medium"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Filter className="size-[15px]" strokeWidth={2} />
          Filters
          {activeCount > 0 ? (
            <span className="text-muted-foreground">({activeCount} selected)</span>
          ) : null}
        </Button>
      </div>

      {/* `contents`: no box of its own, so the box still positions against
          the bar — this is only something to hang the ref on. */}
      <div ref={panelRef} className="contents">
        <FilterBuilder
          open={open}
          onOpenChange={setOpen}
          initial={initialFilter}
          labels={labels}
          channels={channels}
          campaigns={campaigns}
          clients={clients}
          currentViewId={currentViewId}
          currentViewName={currentViewName}
        />
      </div>
    </div>
  );
}
