"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Settings2, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/mi-ui/button";
import { Input } from "@/components/mi-ui/input";
import { cn } from "@/lib/tools/master-inbox/utils";
import {
  DEFAULT_STAGE_LABELS,
  STAGE_LABEL_MAX_LEN,
  STAGE_ORDER,
  type PipelineStage,
} from "@/lib/tools/master-inbox/portals/stages-shared";
import { STAGE_STYLE } from "@/components/master-inbox/portals-ui/pipeline-board";
import { useVisibleStages } from "@/components/master-inbox/portals-ui/stage-labels-context";

// Per-client editor for the pipeline stage display labels. Sits at
// the top of the Recruiting Pipeline page as a collapsible card.
// Collapsed shows just a title + hint; expanded reveals a responsive
// grid of inputs, one per stage. Save batches everything in a single
// PATCH so partial-save anxiety doesn't exist.
//
// Default state = empty / using defaults across the board.

type Drafts = Partial<Record<PipelineStage, string>>;

export function StageLabelEditor({
  token,
  savedOverrides,
}: {
  token: string;
  // The raw jsonb map straight from clients.stage_label_overrides
  // — unknown keys and non-string values are tolerated and ignored.
  savedOverrides: Record<string, unknown>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const initial = useMemo<Drafts>(() => readDrafts(savedOverrides), [savedOverrides]);
  const [drafts, setDrafts] = useState<Drafts>(initial);
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  // Per-client visible stages. Real clients only see editable tiles
  // for the eight stages they've always had; Demo Portal (with the
  // interview_scheduled_stage flag) also gets the new Interview
  // Scheduled tile. Internal state machinery (dirty / anyOverride /
  // payload build) keeps iterating STAGE_ORDER so a flag-enabled
  // client's existing overrides are never accidentally dropped when
  // the flag is toggled.
  const visibleStages = useVisibleStages();

  const dirty = useMemo(() => {
    for (const stage of STAGE_ORDER) {
      const a = (initial[stage] ?? "").trim();
      const b = (drafts[stage] ?? "").trim();
      if (a !== b) return true;
    }
    return false;
  }, [drafts, initial]);

  const anyOverride = useMemo(
    () => STAGE_ORDER.some((s) => (drafts[s] ?? "").trim().length > 0),
    [drafts],
  );

  async function save() {
    const payload: Record<string, string> = {};
    for (const stage of STAGE_ORDER) {
      const v = (drafts[stage] ?? "").trim();
      if (v) payload[stage] = v.slice(0, STAGE_LABEL_MAX_LEN);
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/tools/master-inbox/portal/${token}/stage-labels`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: payload }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? "Could not save names");
        return;
      }
      toast.success("Stage names updated");
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  function resetAll() {
    if (!anyOverride) return;
    if (
      !confirm(
        "Reset every stage name back to the default? This affects everyone viewing this portal.",
      )
    )
      return;
    const cleared: Drafts = {};
    setDrafts(cleared);
    // Persist immediately so the reset isn't lost if the user closes
    // the card without saving.
    void (async () => {
      setSaving(true);
      try {
        const res = await fetch(`/api/tools/master-inbox/portal/${token}/stage-labels`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overrides: {} }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          toast.error(j.error ?? "Could not reset");
          return;
        }
        toast.success("Stage names reset to defaults");
        startTransition(() => router.refresh());
      } finally {
        setSaving(false);
      }
    })();
  }

  const busy = saving || pending;

  return (
    <section className="mb-4 overflow-hidden rounded-2xl border border-[#ebecf0] bg-white shadow-sm transition-colors">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-[#fafbfc] sm:px-5"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#eaf2fd] text-[#1565C0]">
          <Settings2 className="size-[16px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-[#0f1320]">
            Stage names
          </span>
          <span className="mt-0.5 block text-[12px] leading-snug text-[#5b6472]">
            Name each stage however your team refers to it. Applies to
            everyone viewing this portal.
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-[#9aa0ab] transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div className="border-t border-[#ebecf0] bg-[#fafbfc] px-4 pb-4 pt-4 sm:px-5 sm:pb-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {visibleStages.map((stage) => {
              const placeholder = DEFAULT_STAGE_LABELS[stage];
              const value = drafts[stage] ?? "";
              return (
                <label
                  key={stage}
                  className="group flex items-center gap-2.5 rounded-xl border border-[#ebecf0] bg-white px-3 py-2.5 shadow-[0_1px_0_rgba(0,0,0,0.02)] transition-colors focus-within:border-[#1565C0]"
                >
                  {/* Color dot identifies the stage; no caption — the
                      placeholder carries the default name so the tile
                      reads as "name your stage" rather than "rename X
                      to Y". */}
                  <span
                    aria-hidden
                    className={cn(
                      "inline-block size-2.5 shrink-0 rounded-full",
                      STAGE_STYLE[stage].bg,
                    )}
                  />
                  <Input
                    value={value}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [stage]: e.target.value }))
                    }
                    placeholder={placeholder}
                    maxLength={STAGE_LABEL_MAX_LEN}
                    disabled={busy}
                    aria-label={placeholder}
                    // text-[16px] minimum keeps iOS Safari from auto-zooming
                    // when the input gains focus.
                    className="h-9 border-0 bg-transparent px-0 text-[16px] shadow-none focus-visible:ring-0 sm:text-[13.5px]"
                  />
                </label>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={resetAll}
              disabled={busy || !anyOverride}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-[12.5px] font-medium text-[#5b6472] transition-colors hover:bg-[#f6f7f9] hover:text-[#0f1320] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCcw className="size-3.5" />
              Reset all
            </button>
            <Button onClick={save} disabled={busy || !dirty} className="min-w-[120px]">
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Save changes"
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// Extract the editable string drafts from the raw jsonb map.
// Falls back to empty string for anything missing or malformed.
function readDrafts(overrides: Record<string, unknown>): Drafts {
  const drafts: Drafts = {};
  for (const stage of STAGE_ORDER) {
    const raw = overrides?.[stage];
    if (typeof raw === "string") drafts[stage] = raw;
  }
  return drafts;
}
