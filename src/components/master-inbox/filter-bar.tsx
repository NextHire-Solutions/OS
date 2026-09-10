"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Filter, Loader2 } from "lucide-react";
import { Button } from "@/components/mi-ui/button";
import { FilterBuilder } from "@/components/master-inbox/filter-builder";
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

  return (
    <div className="relative">
      <div className="h-11 shrink-0 border-b bg-background flex items-center px-3 gap-2">
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
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-[13px] font-medium"
          onClick={() => setOpen((v) => !v)}
        >
          <Filter className="size-[15px]" strokeWidth={2} />
          Filters
          {activeCount > 0 ? (
            <span className="text-muted-foreground">({activeCount} selected)</span>
          ) : null}
        </Button>
      </div>

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
  );
}
