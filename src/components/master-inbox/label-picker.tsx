"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Tag, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/mi-ui/dropdown-menu";
import { LabelChip } from "@/components/master-inbox/label-chip";
import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels-shared";
import { cn } from "@/lib/tools/master-inbox/utils";

export function LabelPickerButton({
  threadId,
  allLabels,
  assignedLabelIds,
}: {
  threadId: string;
  allLabels: LabelRow[];
  assignedLabelIds: string[];
}) {
  const router = useRouter();
  const [assigned, setAssigned] = useState<Set<string>>(new Set(assignedLabelIds));
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState("");

  // Case-insensitive substring match on the label name — mirrors the
  // composer's TemplatePicker so the two dropdowns feel the same.
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allLabels;
    return allLabels.filter((l) => l.name.toLowerCase().includes(q));
  }, [allLabels, filter]);

  // Single-label-per-thread (May 2026 client decision). Clicking a
  // label:
  //   - currently applied  → DELETE that one (thread becomes unlabeled)
  //   - any other          → POST it; the server clears every other
  //                          label on the thread (incl. AI guesses)
  //                          before inserting this one, so optimistic
  //                          state mirrors that by replacing the
  //                          local set with a single id.
  async function toggle(labelId: string) {
    const isOn = assigned.has(labelId);
    const previous = new Set(assigned);
    const next = isOn ? new Set<string>() : new Set<string>([labelId]);
    setAssigned(next);

    const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/labels`, {
      method: isOn ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label_id: labelId }),
    });
    if (!res.ok) {
      // Roll back optimistic state on failure.
      setAssigned(previous);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Labels"
            className="size-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <Tag className="size-[15px]" strokeWidth={2} />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-64 max-h-80 overflow-y-auto p-0">
        {allLabels.length === 0 ? (
          <p className="text-xs text-muted-foreground px-2 py-3 text-center">
            No labels yet. Create one in Settings → Labels.
          </p>
        ) : (
          <>
            <div className="sticky top-0 z-10 border-b bg-background p-1.5">
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                placeholder="Search labels…"
                autoFocus
                className="h-7 w-full rounded-md border bg-background px-2 text-xs placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>
            <div className="p-1">
              {visible.length === 0 ? (
                <p className="text-xs text-muted-foreground px-2 py-3 text-center">
                  No labels match &quot;{filter}&quot;.
                </p>
              ) : (
                visible.map((l) => {
                  const isOn = assigned.has(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      disabled={pending}
                      onClick={() => toggle(l.id)}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm hover:bg-accent transition-colors",
                        pending && "opacity-50",
                      )}
                    >
                      <span className="size-4 flex items-center justify-center">
                        {isOn ? <Check className="size-3.5" /> : null}
                      </span>
                      <LabelChip name={l.name} color={l.color} />
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
