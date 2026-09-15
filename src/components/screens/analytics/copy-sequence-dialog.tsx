"use client";

import { useState } from "react";

import {
  CAMPAIGNS_URL,
  applyCopySequence,
  planCopySequence,
  useAnalyticsData,
  type CopyMode,
  type CopyPlan,
} from "./actions";
import { DialogFrame, Fail, Panel, Warn } from "./dialog-frame";
import { Check, Search } from "./shared";
import { Btn } from "./toast";

/*
 * Copy a sequence into this campaign (spec §9.4) — the tool's
 * `components/campaigns/copy-sequence-dialog.tsx`.
 *
 * "Written as a guided flow, because replacing a live campaign's emails is the
 * most consequential thing you can do here."
 *
 * Three steps, in the spec's order: pick the source, choose how, review exactly
 * what will happen. The review step is not a summary — it lists the steps being
 * created AND, for Replace, the ones being destroyed, because EmailBison has no
 * atomic replace and no undo. The review is the route's own dry run
 * (`apply:false`), so what is shown is what will be done.
 */

export interface CampaignOption {
  id: number;
  name: string;
  status: string;
}

/**
 * The EmailBison campaigns, as copy sources and push targets.
 *
 * EmailBison only: the copy-sequence route addresses both ends by integer id
 * and its reads/writes are EmailBison's step endpoints, so an Instantly uuid
 * would be refused at the door. Filtered here rather than offered and failed.
 */
export function useCampaignOptions(open: boolean, exclude?: number) {
  const list = useAnalyticsData<{
    items: Array<{ id: string; platform: string; name: string; status: string }>;
  }>(CAMPAIGNS_URL("status=all&limit=500"), { skip: !open });
  const options: CampaignOption[] = (list.data?.items ?? [])
    .filter((c) => c.platform === "emailbison")
    .map((c) => ({ id: Number(c.id), name: c.name, status: c.status }))
    .filter((c) => c.id !== exclude);
  return { options, loading: list.loading, error: list.error };
}

export function CopySequenceDialog({
  targetId,
  targetName,
  open,
  onOpenChange,
  onApplied,
}: {
  targetId: number;
  targetName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tool's `invalidateQueries(["campaign", id])`. */
  onApplied: () => void;
}) {
  const [stage, setStage] = useState<"pick" | "options" | "review">("pick");
  const [search, setSearch] = useState("");
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [mode, setMode] = useState<CopyMode>("append");
  const [includeVariants, setIncludeVariants] = useState(true);
  const [includeAttachments, setIncludeAttachments] = useState(true);
  /*
   * §9.4 lists copy tags alongside variants and attachments. Defaults on: a
   * sequence copied without its dimensions shows as Untagged in Copy & Offer —
   * dropping out of the analysis that identified it as worth copying.
   */
  const [includeCopyTags, setIncludeCopyTags] = useState(true);
  const [plan, setPlan] = useState<CopyPlan | null>(null);
  const [typed, setTyped] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  // A campaign cannot be its own source; excluded here so it can't be picked.
  const { options: all, loading } = useCampaignOptions(open, targetId);
  const q = search.trim().toLowerCase();
  const options = q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
  const source = all.find((c) => c.id === sourceId);

  const opts = { includeVariants, includeAttachments, includeCopyTags };

  async function preview() {
    if (!sourceId) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      setPlan(await planCopySequence(targetId, sourceId, mode, opts));
      setStage("review");
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Could not build the preview");
    } finally {
      setPreviewing(false);
    }
  }

  async function commit() {
    if (!sourceId) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const { ok, body } = await applyCopySequence(targetId, sourceId, mode, opts);
      if (!ok) {
        throw new Error(
          body.targetLeftEmpty
            ? `${body.error}\n\nThis campaign now has NO sequence. Its previous steps are preserved in the Activity tab.`
            : (body.error ?? "The copy could not be applied"),
        );
      }
      onApplied();
      close();
    } catch (e) {
      setCommitError(e instanceof Error ? e.message : "The copy could not be applied");
    } finally {
      setCommitting(false);
    }
  }

  function close() {
    onOpenChange(false);
    // Reset so reopening starts the guided flow from the beginning rather than
    // on a stale review of a plan built from different options.
    setStage("pick");
    setSourceId(null);
    setPlan(null);
    setTyped("");
    setSearch("");
    setPreviewError(null);
    setCommitError(null);
  }

  /*
   * Replace destroys emails with no undo, so it asks for the campaign name to
   * be typed. Append only adds, so it doesn't — an unskippable ritual on the
   * safe path is how people learn to type past the dangerous one too.
   */
  const needsTyped = mode === "replace" && (plan?.removing.length ?? 0) > 0;
  const confirmed = !needsTyped || typed.trim() === targetName.trim();
  /*
   * Disabled, not just warned. EmailBison refuses to delete a step that has
   * sent, so Replace here would delete what it can, fail on the first step with
   * volume, and leave a half-dismantled sequence. Better to not offer it.
   */
  const blockedByVolume = Boolean(plan?.blocked);

  const created = plan?.steps.filter((s) => !s.isVariant).length ?? 0;
  const createdVariants = plan?.steps.filter((s) => s.isVariant).length ?? 0;

  return (
    <DialogFrame
      open={open}
      onClose={committing ? () => {} : close}
      width={680}
      title={`Copy a sequence into “${targetName}”`}
      footer={
        <>
          {stage !== "pick" ? (
            <Btn disabled={committing} onClick={() => setStage(stage === "review" ? "options" : "pick")}>Back</Btn>
          ) : null}
          <span style={{ flex: 1 }} />
          {stage === "pick" ? (
            <Btn primary disabled={!sourceId} onClick={() => setStage("options")}>Continue</Btn>
          ) : null}
          {stage === "options" ? (
            <Btn primary disabled={previewing} onClick={() => void preview()}>
              {previewing ? "Building preview…" : "Review changes"}
            </Btn>
          ) : null}
          {stage === "review" ? (
            <Btn
              primary={!plan?.removing.length}
              disabled={!confirmed || blockedByVolume || committing || !plan?.steps.length}
              onClick={() => void commit()}
              style={plan?.removing.length ? { color: "#fff", background: "var(--red)", borderColor: "var(--red)" } : undefined}
            >
              {committing
                ? "Applying…"
                : plan?.removing.length
                  ? `Replace ${plan.removing.length} step${plan.removing.length === 1 ? "" : "s"}`
                  : `Add ${plan?.steps.length ?? 0} step${plan?.steps.length === 1 ? "" : "s"}`}
            </Btn>
          ) : null}
        </>
      }
    >
      {stage === "pick" ? (
        <>
          <Search value={search} onChange={setSearch} placeholder="Search campaigns to copy from…" width={320} />
          <div style={{ maxHeight: 288, overflowY: "auto", border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 4 }}>
            {loading && !all.length ? (
              <div className="mut" style={{ padding: 16, textAlign: "center", fontSize: 12.5 }}>Loading campaigns…</div>
            ) : options.length === 0 ? (
              <div className="mut" style={{ padding: 16, textAlign: "center", fontSize: 12.5 }}>No campaigns match</div>
            ) : (
              options.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSourceId(c.id)}
                  aria-pressed={sourceId === c.id}
                  style={{
                    display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "6px 8px",
                    border: 0, borderRadius: 6, background: sourceId === c.id ? "var(--blue-pale)" : "none",
                    cursor: "pointer", font: "inherit", fontSize: 12.5, textAlign: "left",
                  }}
                >
                  <span aria-hidden style={{ width: 14, height: 14, borderRadius: 7, border: "1px solid var(--line)", background: sourceId === c.id ? "var(--blue)" : "var(--surface)", flex: "none" }} />
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                  <span className="mut" style={{ flex: "none" }}>{c.status}</span>
                </button>
              ))
            )}
          </div>
        </>
      ) : null}

      {stage === "options" ? (
        <>
          <div className="mut" style={{ fontSize: 12.5 }}>
            Copying from <b style={{ color: "var(--ink)" }}>{source?.name}</b>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {(
              [
                ["append", "Append", "Add these steps after the campaign's existing sequence."],
                [
                  "replace",
                  "Replace",
                  "Delete the existing sequence first. EmailBison has no undo — the old steps are recorded in Activity before anything is removed.",
                ],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 10, padding: 10, cursor: "pointer",
                  border: `1px solid ${mode === value ? (value === "replace" ? "var(--yellow)" : "var(--blue)") : "var(--line)"}`,
                  borderRadius: "var(--r-md)",
                  background: mode === value ? (value === "replace" ? "var(--yellow-bg)" : "var(--blue-pale)") : undefined,
                }}
              >
                <input
                  type="radio"
                  name="copy-mode"
                  checked={mode === value}
                  onChange={() => {
                    setMode(value);
                    // Clear the previous mode's failure. Otherwise a Replace
                    // error ("cannot be deleted…") sits under an Append,
                    // which deletes nothing.
                    setPreviewError(null);
                    setCommitError(null);
                  }}
                  style={{ accentColor: "var(--blue)", marginTop: 2 }}
                />
                <span>
                  <span style={{ display: "block", fontWeight: 600, fontSize: 13 }}>{label}</span>
                  <span className="mut" style={{ display: "block", fontSize: 12 }}>{hint}</span>
                </span>
              </label>
            ))}
          </div>
          <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--line-soft)", paddingTop: 10 }}>
            <Check checked={includeVariants} onChange={setIncludeVariants} label="Bring variants" />
            <Check checked={includeAttachments} onChange={setIncludeAttachments} label="Bring attachments" />
            <Check checked={includeCopyTags} onChange={setIncludeCopyTags} label="Bring copy tags" />
          </div>
          {previewError ? <Fail>{previewError}</Fail> : null}
        </>
      ) : null}

      {stage === "review" && plan ? (
        <>
          {plan.warnings.map((warning, i) => (
            <Warn key={i}>{warning}</Warn>
          ))}

          {plan.removing.length ? (
            <div>
              <div className="grp-h" style={{ padding: "0 0 6px", color: "var(--red)" }}>
                Will be deleted ({plan.removing.length})
              </div>
              <Panel style={{ maxHeight: 112, overflowY: "auto", borderColor: "var(--red)", background: "var(--red-bg)", fontSize: 12.5 }}>
                {plan.removing.map((step, i) => (
                  <div key={i} style={{ textDecoration: "line-through", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {step.order}. {step.subject || "(no subject)"}
                  </div>
                ))}
              </Panel>
            </div>
          ) : null}

          <div>
            <div className="grp-h" style={{ padding: "0 0 6px" }}>
              Will be created ({created} step{created === 1 ? "" : "s"}
              {createdVariants ? ` · ${createdVariants} variant${createdVariants === 1 ? "" : "s"}` : ""})
            </div>
            <Panel style={{ maxHeight: 208, overflowY: "auto", fontSize: 12.5, display: "grid", gap: 6 }}>
              {plan.steps.map((step, i) => (
                <div key={i}>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    {/* A variant has no position of its own — it replaces the
                        step above it — so numbering it would imply an extra
                        email that never gets sent. */}
                    <span className="tnum mut" style={{ flex: "none" }}>{step.isVariant ? "↳" : `${step.order}.`}</span>
                    <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {step.subject || "(no subject)"}
                    </span>
                    {/* wait_in_days is the gap AFTER a step, so the last step's
                        is inert and a variant has none of its own. */}
                    <span className="tnum mut" style={{ flex: "none" }}>
                      {step.isVariant ? "" : step.waitInDays ? `then ${step.waitInDays}d` : ""}
                    </span>
                    {step.isVariant ? <span className="badge s-done" style={{ padding: "1px 6px", fontSize: 11 }}>variant</span> : null}
                  </span>
                  {step.opening ? (
                    <span className="mut" style={{ display: "block", paddingLeft: 24, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {step.opening}
                    </span>
                  ) : null}
                </div>
              ))}
            </Panel>
          </div>

          {blockedByVolume ? (
            <Fail>Replace is unavailable for this campaign. Switch to Append, or delete the sent steps in EmailBison first.</Fail>
          ) : null}

          {needsTyped && !blockedByVolume ? (
            <label style={{ display: "block" }}>
              <span className="as-l">
                Type <b>{targetName}</b> to confirm deleting its current sequence
              </span>
              <input className="inp" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={targetName} style={{ width: "100%" }} />
            </label>
          ) : null}

          {commitError ? <Fail>{commitError}</Fail> : null}
        </>
      ) : null}
    </DialogFrame>
  );
}
