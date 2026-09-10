"use client";

import { useEffect, useState } from "react";
import { Loader2, ListPlus, Check, ListChecks } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/mi-ui/dropdown-menu";

interface FollowupCampaign {
  id: number;
  name: string;
  status: string | null;
}

interface FollowupStatus {
  loading: boolean;
  status: "active" | "past" | "none";
  campaignName: string | null;
  nextScheduledAt: string | null;
}

// Button + dropdown for EmailBison threads. Lazy-loads the list of
// reply_followup campaigns in the thread's team, then on click pushes the
// thread's latest inbound reply (and its lead) into the selected campaign
// via POST /api/replies/{reply_id}/followup-campaign/push.
//
// Before the picker is shown we check whether the lead is already
// actively enrolled in a reply_followup campaign — if so the picker is
// replaced with an "Already in: X" badge + a disabled button (mirrors
// the Instantly SubsequenceSection UX so the user can't double-enrol).
//
// Parallel to <SubsequencePicker /> which handles the equivalent
// Instantly flow.
export function FollowupCampaignPicker({ threadId }: { threadId: string }) {
  const [items, setItems] = useState<FollowupCampaign[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<number | null>(null);
  const [movedIds, setMovedIds] = useState<Set<number>>(new Set());
  const [enrolment, setEnrolment] = useState<FollowupStatus>({
    loading: true,
    status: "none",
    campaignName: null,
    nextScheduledAt: null,
  });

  useEffect(() => {
    let cancelled = false;
    setEnrolment({ loading: true, status: "none", campaignName: null, nextScheduledAt: null });
    fetch(`/api/tools/master-inbox/threads/${threadId}/followup-status`, { cache: "no-store" })
      .then((r) => r.json())
      .then(
        (j: {
          ok?: boolean;
          status?: "active" | "past" | "none";
          campaignName?: string | null;
          nextScheduledAt?: string | null;
        }) => {
          if (cancelled) return;
          setEnrolment({
            loading: false,
            status: j.status ?? "none",
            campaignName: j.campaignName ?? null,
            nextScheduledAt: j.nextScheduledAt ?? null,
          });
        },
      )
      .catch(() => {
        // Status lookup failed — fall back to the original "no enrolment
        // known" state so the picker is still usable. We surface the
        // error in the toast if/when the user tries to push.
        if (!cancelled) {
          setEnrolment({
            loading: false,
            status: "none",
            campaignName: null,
            nextScheduledAt: null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  async function ensureLoaded() {
    if (items !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/followup-campaigns`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        items?: FollowupCampaign[];
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Failed to load follow-up campaigns");
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

  async function push(c: FollowupCampaign) {
    if (movingId) return;
    setMovingId(c.id);
    try {
      const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/followup-campaigns/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: c.id }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string | null;
      };
      if (!res.ok || !json.ok) {
        toast.error(json.error ?? "Push failed");
        return;
      }
      toast.success(json.message ?? `Added to "${c.name}"`);
      setMovedIds((cur) => new Set(cur).add(c.id));
      // Optimistically flip local state so the picker disables itself
      // immediately; the server-side syncThreadFollowup will firm it
      // up on the next status fetch.
      setEnrolment({
        loading: false,
        status: "active",
        campaignName: c.name,
        nextScheduledAt: null,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Push failed");
    } finally {
      setMovingId(null);
    }
  }

  // Disabled placeholder used in two states (loading + already enrolled)
  // so the layout doesn't shift between them.
  if (enrolment.loading) {
    return <DisabledAddButton label="Add to follow-up campaign" />;
  }

  if (enrolment.status === "active") {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-amber-900">
          <ListChecks className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
              Already in a follow-up campaign
            </div>
            <div className="text-[13px] font-medium break-words">
              {enrolment.campaignName ?? "Active follow-up campaign"}
            </div>
            {enrolment.nextScheduledAt ? (
              <div className="text-[11px] text-amber-700/80">
                Next send {fmtScheduled(enrolment.nextScheduledAt)}
              </div>
            ) : null}
          </div>
        </div>
        <DisabledAddButton label="Already in a follow-up campaign" />
      </div>
    );
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
            Add to follow-up campaign
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-80 max-h-72 overflow-y-auto">
        {enrolment.status === "past" && enrolment.campaignName ? (
          <div className="px-3 py-2 text-[11px] text-muted-foreground border-b">
            Previously in: {enrolment.campaignName} (completed)
          </div>
        ) : null}
        {loading ? (
          <div className="px-3 py-3 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            Loading…
          </div>
        ) : error ? (
          <div className="px-3 py-3 text-sm text-red-600">{error}</div>
        ) : (items ?? []).length === 0 ? (
          <div className="px-3 py-3 text-sm text-muted-foreground">
            No reply follow-up campaigns in this EmailBison team. Create one
            with type &quot;reply_followup&quot; first.
          </div>
        ) : (
          (items ?? []).map((c) => {
            const moved = movedIds.has(c.id);
            const isMoving = movingId === c.id;
            return (
              <DropdownMenuItem
                key={c.id}
                disabled={isMoving || moved}
                onClick={() => push(c)}
                className="flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="truncate">{c.name}</div>
                  {c.status ? (
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      {c.status}
                    </div>
                  ) : null}
                </div>
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

function DisabledAddButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      disabled
      title="This lead is already in a follow-up campaign — remove them in EmailBison before adding to another."
      className="w-full inline-flex items-center justify-center gap-2 h-9 px-3 rounded-md border bg-muted/40 text-sm font-medium text-muted-foreground cursor-not-allowed"
    >
      <ListPlus className="size-3.5" />
      {label}
    </button>
  );
}

function fmtScheduled(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = d.getTime() - Date.now();
  if (diffMs < 0) return "soon";
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `in ${Math.max(1, mins)}m`;
  if (mins < 1440) return `in ${Math.round(mins / 60)}h`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
