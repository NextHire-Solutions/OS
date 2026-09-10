"use client";

import { useState } from "react";
import { Loader2, ListPlus, Check } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/mi-ui/dropdown-menu";

interface Subsequence {
  id: string;
  name: string;
  status: number | null;
}

// Button + dropdown that lets the user move the thread's lead into one of
// the Instantly subsequences attached to this thread's campaign.
//
// Subsequence list loads lazily on first open (fewer requests on render).
export function SubsequencePicker({ threadId }: { threadId: string }) {
  const [items, setItems] = useState<Subsequence[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [movedIds, setMovedIds] = useState<Set<string>>(new Set());

  async function ensureLoaded() {
    if (items !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/subsequences`, {
        cache: "no-store",
      });
      const json = (await res.json()) as { ok?: boolean; items?: Subsequence[]; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Failed to load subsequences");
        setItems([]);
        return;
      }
      setItems(json.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  async function move(sub: Subsequence) {
    if (movingId) return;
    setMovingId(sub.id);
    try {
      const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/subsequences/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subsequence_id: sub.id }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        body?: unknown;
      };
      if (!res.ok || !json.ok) {
        toast.error(json.error ?? "Move failed");
        return;
      }
      toast.success(`Added to "${sub.name}"`);
      setMovedIds((cur) => new Set(cur).add(sub.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Move failed");
    } finally {
      setMovingId(null);
    }
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && ensureLoaded()}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="w-full inline-flex items-center justify-center gap-2 h-9 px-3 rounded-md border bg-background text-sm font-medium hover:bg-accent transition-colors"
          >
            <ListPlus className="size-3.5" />
            Add to subsequence
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-72 max-h-72 overflow-y-auto">
        {loading ? (
          <div className="px-3 py-3 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            Loading…
          </div>
        ) : error ? (
          <div className="px-3 py-3 text-sm text-red-600">{error}</div>
        ) : (items ?? []).length === 0 ? (
          <div className="px-3 py-3 text-sm text-muted-foreground">
            No subsequences on this campaign yet. Create one in Instantly first.
          </div>
        ) : (
          (items ?? []).map((s) => {
            const moved = movedIds.has(s.id);
            const isMoving = movingId === s.id;
            return (
              <DropdownMenuItem
                key={s.id}
                disabled={isMoving || moved}
                onClick={() => move(s)}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">{s.name}</span>
                {isMoving ? (
                  <Loader2 className="size-3.5 animate-spin shrink-0" />
                ) : moved ? (
                  <Check className="size-3.5 text-emerald-600 shrink-0" />
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
