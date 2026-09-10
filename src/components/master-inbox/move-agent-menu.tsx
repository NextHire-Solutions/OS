"use client";

import { useState } from "react";
import { ArrowRightLeft, Check, ChevronDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/mi-ui/dropdown-menu";
import { cn } from "@/lib/tools/master-inbox/utils";

// "Move agent" — re-tags the given thread(s) to a different client.
// Reused by the open-thread toolbar (one thread) and the bulk-actions
// bar (many threads). Lazily fetches the FULL client roster from
// /api/clients on first open so agents can be moved to any client,
// including ones with zero threads.
//
// Never throws — clipboard/network failures surface as a toast.

type ClientRow = {
  id: string;
  name: string;
  slug: string;
  is_system?: boolean;
};

export function MoveAgentMenu({
  threadIds,
  currentClientId,
  onMoved,
  disabled = false,
  compact = false,
}: {
  threadIds: string[];
  // When set, that client is checkmarked + disabled (can't move to self).
  // null for bulk (mixed selection).
  currentClientId: string | null;
  onMoved: () => void;
  disabled?: boolean;
  // compact = icon-only trigger (open-thread toolbar); otherwise a
  // labelled "Move agent" button (bulk bar).
  compact?: boolean;
}) {
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  async function ensureClients() {
    if (clients || loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/tools/master-inbox/clients");
      if (!res.ok) throw new Error("failed");
      const json = (await res.json()) as { clients?: ClientRow[] };
      const list = (json.clients ?? [])
        .filter((c) => !c.is_system)
        .sort((a, b) => a.name.localeCompare(b.name));
      setClients(list);
    } catch {
      toast.error("Could not load clients");
      setClients([]);
    } finally {
      setLoading(false);
    }
  }

  async function move(clientId: string, clientName: string) {
    if (busy || threadIds.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/tools/master-inbox/threads/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "move_client",
          thread_ids: threadIds,
          client_id: clientId,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Move failed");
        return;
      }
      const n = threadIds.length;
      toast.success(
        n === 1
          ? `Moved to ${clientName}`
          : `Moved ${n} agents to ${clientName}`,
      );
      onMoved();
    } catch {
      toast.error("Move failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void ensureClients();
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            disabled={disabled || busy}
            aria-label="Move agent"
            title="Move agent to another client"
            className={cn(
              "inline-flex items-center gap-1 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
              compact ? "h-8 w-8 justify-center" : "h-8 px-2",
              (disabled || busy) && "opacity-50 cursor-not-allowed",
            )}
          >
            {busy ? (
              <Loader2 className="size-[15px] animate-spin" strokeWidth={2} />
            ) : (
              <ArrowRightLeft className="size-[15px]" strokeWidth={2} />
            )}
            {compact ? null : (
              <>
                <span className="text-[13px]">Move agent</span>
                <ChevronDown className="size-3" />
              </>
            )}
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-60 max-h-80 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading clients…
          </div>
        ) : !clients || clients.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            No clients found.
          </div>
        ) : (
          clients.map((c) => {
            const isCurrent = currentClientId != null && c.id === currentClientId;
            return (
              <DropdownMenuItem
                key={c.id}
                disabled={isCurrent || busy}
                onClick={() => {
                  if (!isCurrent) void move(c.id, c.name);
                }}
                className="gap-2"
              >
                <Check
                  className={cn("size-3.5", isCurrent ? "opacity-100" : "opacity-0")}
                />
                <span className="truncate">{c.name}</span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
