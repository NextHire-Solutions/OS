"use client";

import { useEffect, useState } from "react";
import { ListChecks, ListPlus } from "lucide-react";
import { SubsequencePicker } from "@/components/master-inbox/subsequence-picker";

interface Status {
  loading: boolean;
  inSubsequence: boolean;
  name: string | null;
  addedAt: string | null;
}

// Subsequence area of the prospect panel. Loads the lead's current
// subsequence status, then either:
//   - shows the "Add to subsequence" picker (lead not in one), or
//   - shows an "Already in a subsequence" notice + a DISABLED button —
//     a lead can only be in one subsequence at a time, so re-adding is
//     blocked until they're removed in Instantly.
export function SubsequenceSection({ threadId }: { threadId: string }) {
  const [status, setStatus] = useState<Status>({
    loading: true,
    inSubsequence: false,
    name: null,
    addedAt: null,
  });

  useEffect(() => {
    let cancelled = false;
    setStatus({ loading: true, inSubsequence: false, name: null, addedAt: null });
    fetch(`/api/tools/master-inbox/threads/${threadId}/subsequence-status`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { inSubsequence?: boolean; name?: string | null; addedAt?: string | null }) => {
        if (cancelled) return;
        setStatus({
          loading: false,
          inSubsequence: Boolean(j.inSubsequence),
          name: j.name ?? null,
          addedAt: j.addedAt ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setStatus((s) => ({ ...s, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // While the status loads, keep the button disabled so a lead can't be
  // added before we know whether they're already in a subsequence.
  if (status.loading) {
    return <DisabledAddButton label="Add to subsequence" />;
  }

  if (status.inSubsequence) {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-amber-900">
          <ListChecks className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
              Already in a subsequence
            </div>
            <div className="text-[13px] font-medium break-words">
              {status.name ?? "Active subsequence"}
            </div>
            {status.addedAt ? (
              <div className="text-[11px] text-amber-700/80">
                Added {fmtAdded(status.addedAt)}
              </div>
            ) : null}
          </div>
        </div>
        <DisabledAddButton label="Already in a subsequence" />
      </div>
    );
  }

  return <SubsequencePicker threadId={threadId} />;
}

function DisabledAddButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      disabled
      title="This lead is already in a subsequence — remove them in Instantly before adding to another."
      className="w-full inline-flex items-center justify-center gap-2 h-9 px-3 rounded-md border bg-muted/40 text-sm font-medium text-muted-foreground cursor-not-allowed"
    >
      <ListPlus className="size-3.5" />
      {label}
    </button>
  );
}

function fmtAdded(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "recently";
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
