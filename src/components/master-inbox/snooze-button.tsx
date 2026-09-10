"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/mi-ui/dropdown-menu";
import { Input } from "@/components/mi-ui/input";
import { Button } from "@/components/mi-ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import { toast } from "sonner";
import { cn } from "@/lib/tools/master-inbox/utils";

// Preset snooze targets. Each `compute` returns the ISO timestamp the user
// is implicitly asking for, expressed relative to "now" at click time.
const PRESETS: Array<{ label: string; compute: () => Date }> = [
  {
    label: "Later today (3 hours)",
    compute: () => new Date(Date.now() + 3 * 3600_000),
  },
  {
    label: "Tomorrow morning (9 AM)",
    compute: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
  {
    label: "This weekend (Saturday 9 AM)",
    compute: () => {
      const d = new Date();
      const day = d.getDay();
      const daysToSat = (6 - day + 7) % 7 || 7;
      d.setDate(d.getDate() + daysToSat);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
  {
    label: "Next Monday (9 AM)",
    compute: () => {
      const d = new Date();
      const day = d.getDay();
      const daysToMon = ((1 - day + 7) % 7) || 7;
      d.setDate(d.getDate() + daysToMon);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
  {
    label: "Next week (7 days)",
    compute: () => new Date(Date.now() + 7 * 86400_000),
  },
];

export function SnoozeButton({
  threadId,
  backHref,
  isSnoozed,
  disabled = false,
}: {
  threadId: string;
  backHref: string;
  isSnoozed: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [customOpen, setCustomOpen] = useState(false);
  const [customAt, setCustomAt] = useState("");
  const [pending, startTransition] = useTransition();

  async function snooze(remindAt: Date) {
    const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/snooze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remind_at: remindAt.toISOString() }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Snooze failed");
      return;
    }
    toast.success(`Snoozed until ${remindAt.toLocaleString("en-US", { timeZone: "America/New_York" })}`);
    startTransition(() => router.push(backHref));
  }

  async function unsnooze() {
    const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/snooze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismiss: true }),
    });
    if (!res.ok) {
      toast.error("Could not un-snooze.");
      return;
    }
    toast.success("Moved back to inbox.");
    startTransition(() => router.push(backHref));
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              disabled={disabled || pending}
              aria-label={isSnoozed ? "Snoozed (manage)" : "Snooze"}
              title={isSnoozed ? "Snoozed — click to manage" : "Snooze"}
              className={cn(
                "size-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
                isSnoozed && "text-amber-600",
                (disabled || pending) && "opacity-40 pointer-events-none",
              )}
            >
              <Clock className="size-[15px]" strokeWidth={2} />
            </button>
          }
        />
        <DropdownMenuContent align="end" className="w-56">
          {isSnoozed ? (
            <DropdownMenuItem onClick={unsnooze}>Move back to inbox</DropdownMenuItem>
          ) : (
            <>
              {PRESETS.map((p) => (
                <DropdownMenuItem key={p.label} onClick={() => snooze(p.compute())}>
                  {p.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onClick={() => setCustomOpen(true)}>
                Custom date & time…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Snooze until</DialogTitle>
          </DialogHeader>
          <Input
            type="datetime-local"
            value={customAt}
            onChange={(e) => setCustomAt(e.target.value)}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!customAt}
              onClick={() => {
                const d = new Date(customAt);
                if (Number.isNaN(d.getTime())) {
                  toast.error("Pick a valid date.");
                  return;
                }
                if (d.getTime() < Date.now()) {
                  toast.error("Pick a date in the future.");
                  return;
                }
                setCustomOpen(false);
                snooze(d);
              }}
            >
              Snooze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
