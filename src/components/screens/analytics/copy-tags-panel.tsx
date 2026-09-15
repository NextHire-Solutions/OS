"use client";

import { useMemo, useState } from "react";

import { COPY_DIMENSIONS } from "@/lib/tools/analytics/copy-dimensions.ts";
import { COPY_TAGS_URL, saveCopyTags, useAnalyticsData } from "./actions";
import { Box } from "./shared";
import { Btn } from "./toast";

/**
 * The seven copy dimensions for one sequence step.
 *
 * Moved out of campaign-detail.tsx unchanged, because the sequence editor
 * shows it under each open step (§6.3: "Tag the copy's seven dimensions from
 * the same screen") and the Copy & Offer tab shows it for the opener. One
 * panel, two callers.
 *
 * FIRST EMAIL ONLY is measured: `analytics_copy_steps` reads
 * `step_order = 1 AND NOT is_variant`, so a tag on a follow-up is written and
 * then never appears in any table. The editor passes `isFirstEmail` so a
 * follow-up says so before someone spends an afternoon on it. Saving promotes
 * a suggestion to `manual` and stamps `confirmed_at` — which is how "a person
 * agreed with this" stays answerable.
 */
export function CopyTagsPanel({
  stepId,
  subject,
  show,
  isFirstEmail = true,
}: {
  /** Null for a step added in this session — it has no id until the sequence is saved. */
  stepId: number | null;
  subject: string | null;
  show: (t: { text: string; bad?: boolean }) => void;
  isFirstEmail?: boolean;
}) {
  const { data, reload } = useAnalyticsData<{
    stepId: number;
    tags: Record<string, { value: string; source: string } | string>;
    known: Record<string, string[]>;
  }>(COPY_TAGS_URL(stepId ?? 0), { skip: stepId == null });
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);

  const current = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data?.tags ?? {})) {
      out[k] = typeof v === "string" ? v : v?.value ?? "";
    }
    return out;
  }, [data]);

  const values = draft ?? current;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(current);

  if (stepId == null) {
    return (
      <div
        style={{
          border: "1px dashed var(--line)", borderRadius: "var(--r-md)", padding: 12,
          fontSize: 12.5, color: "var(--muted)",
        }}
      >
        Save the sequence first — a new step has to exist before its copy can be tagged.
      </div>
    );
  }

  return (
    <Box
      title="Copy dimensions"
      style={{ marginBottom: 0 }}
      note={
        isFirstEmail ? (
          <>The opening email{subject ? ` — “${subject}”` : ""}. Follow-ups are not tagged; nothing measures them.</>
        ) : (
          <>Follow-up — tags are saved but not included in copy analysis.</>
        )
      }
      right={
        <>
          {dirty ? <span className="badge s-ok">Unsaved</span> : null}
          <Btn
            primary
            disabled={busy || !dirty}
            onClick={async () => {
              setBusy(true);
              try {
                const patch: Record<string, string | null> = {};
                for (const d of COPY_DIMENSIONS) {
                  const next = values[d.key] ?? "";
                  if (next !== (current[d.key] ?? "")) patch[d.key] = next || null;
                }
                await saveCopyTags(stepId, patch);
                await reload();
                setDraft(null);
                show({ text: "Copy dimensions saved" });
              } catch (e) {
                show({ text: e instanceof Error ? e.message : "Could not save", bad: true });
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Btn>
          {dirty ? <Btn disabled={busy} onClick={() => setDraft(null)}>Revert</Btn> : null}
        </>
      }
    >
      <div style={{ padding: 22, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
        {COPY_DIMENSIONS.map((d) => (
          <label key={d.key} style={{ display: "block", minWidth: 0 }}>
            <span className="as-l">
              {d.label}
              {d.hint ? <span className="mut" style={{ fontWeight: 400 }}> {d.hint}</span> : null}
            </span>
            <input
              className="inp"
              list={`known-${stepId}-${d.key}`}
              value={values[d.key] ?? ""}
              disabled={busy}
              placeholder="untagged"
              style={{ width: "100%", minWidth: 0 }}
              onChange={(e) => setDraft({ ...values, [d.key]: e.target.value })}
            />
            {/*
              A datalist of the values already in use, so "Question",
              "question" and "Questions" do not become three dimensions. This is
              exactly what the route's `known` map exists for.
            */}
            <datalist id={`known-${stepId}-${d.key}`}>
              {(data?.known?.[d.key] ?? []).map((v) => <option key={v} value={v} />)}
            </datalist>
          </label>
        ))}
      </div>
    </Box>
  );
}
