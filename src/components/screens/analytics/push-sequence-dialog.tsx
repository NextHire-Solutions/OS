"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AnchoredPanel } from "@/components/ui/anchored-panel";
import { planCopySequence, type CopyMode, type CopyPlan } from "./actions";
import type { DeployBatch } from "./bulk-deploy";
import { useCampaignOptions, type CampaignOption } from "./copy-sequence-dialog";
import { DialogFrame, Panel } from "./dialog-frame";
import { Btn } from "./toast";

/*
 * Push THIS campaign's sequence into others — the tool's
 * `components/campaigns/push-sequence-dialog.tsx`.
 *
 * The mirror of "Copy sequence from…", and the direction people actually want
 * once a campaign is working: roll the proven opener out to the rest. Before
 * this, the only way to do that was from an offer card, which meant creating an
 * offer purely to reuse a sequence.
 *
 * It previews every target rather than the first, because with Replace the
 * answer genuinely differs per campaign — one may have nothing to delete while
 * the next has a step that has already sent and cannot be touched.
 */

interface TargetPlan {
  targetId: number;
  ok: boolean;
  plan?: Pick<CopyPlan, "steps" | "removing" | "blocked" | "warnings">;
  error?: string;
}

export function PushSequenceDialog({
  sourceId,
  sourceName,
  stepCount,
  open,
  onOpenChange,
  onStart,
}: {
  sourceId: number;
  sourceName: string;
  stepCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (batch: DeployBatch) => void;
}) {
  const [targetIds, setTargetIds] = useState<number[]>([]);
  const [mode, setMode] = useState<CopyMode>("append");
  const [plans, setPlans] = useState<TargetPlan[]>([]);
  const [checking, setChecking] = useState(false);

  const { options } = useCampaignOptions(open, sourceId);
  const nameOf = (id: number) => options.find((c) => c.id === id)?.name ?? `#${id}`;

  /*
   * One dry run per target, in parallel, every time the selection or the mode
   * changes. A later change while a batch of previews is still in flight must
   * not be overwritten by it when it lands — hence the token.
   */
  const token = useRef(0);
  useEffect(() => {
    if (!open || targetIds.length === 0) {
      token.current++;
      setPlans([]);
      setChecking(false);
      return;
    }
    const mine = ++token.current;
    setChecking(true);
    void Promise.all(
      targetIds.map(async (targetId): Promise<TargetPlan> => {
        try {
          const plan = await planCopySequence(targetId, sourceId, mode, {
            includeVariants: true,
            includeAttachments: true,
          });
          return { targetId, ok: true, plan };
        } catch (e) {
          return { targetId, ok: false, error: e instanceof Error ? e.message : "Cannot be written to" };
        }
      }),
    ).then((result) => {
      if (token.current !== mine) return;
      setPlans(result);
      setChecking(false);
    });
  }, [open, targetIds, mode, sourceId]);

  const blocked = plans.filter((p) => !p.ok || p.plan?.blocked);
  const ready = plans.filter((p) => p.ok && !p.plan?.blocked);

  return (
    <DialogFrame
      open={open}
      onClose={() => onOpenChange(false)}
      width={560}
      title="Push this sequence to other campaigns"
      description={<>{stepCount} steps from <span style={{ color: "var(--ink)" }}>{sourceName}</span></>}
      footer={
        <>
          <Btn onClick={() => onOpenChange(false)}>Cancel</Btn>
          <Btn
            primary={mode !== "replace"}
            disabled={!ready.length || checking}
            style={mode === "replace" ? { color: "#fff", background: "var(--red)", borderColor: "var(--red)" } : undefined}
            onClick={() => {
              onStart({
                sourceCampaignId: sourceId,
                sourceLabel: sourceName,
                mode,
                tasks: ready.map((p) => ({ campaignId: p.targetId, name: nameOf(p.targetId), status: "pending" as const })),
              });
              onOpenChange(false);
              setTargetIds([]);
            }}
          >
            {mode === "replace" ? "Replace in" : "Push to"} {ready.length} {ready.length === 1 ? "campaign" : "campaigns"}
          </Btn>
        </>
      }
    >
      <div>
        <span className="as-l">Target campaigns</span>
        <CampaignMultiPicker options={options} value={targetIds} onChange={setTargetIds} />
      </div>

      <div style={{ display: "flex", gap: 14, fontSize: 13 }}>
        {(["append", "replace"] as const).map((m) => (
          <label key={m} style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="radio" name="push-mode" checked={mode === m} onChange={() => setMode(m)} style={{ accentColor: "var(--blue)" }} />
            <span style={{ textTransform: "capitalize" }}>{m}</span>
          </label>
        ))}
      </div>

      {checking ? (
        <div className="mut" style={{ fontSize: 12.5 }}>
          Checking {targetIds.length} {targetIds.length === 1 ? "campaign" : "campaigns"}…
        </div>
      ) : null}

      {ready.length ? (
        <Panel style={{ background: "var(--inset)", fontSize: 12.5 }}>
          <b>{ready.length}</b> ready
          {mode === "replace"
            ? ` · ${ready.reduce((n, p) => n + (p.plan?.removing.length ?? 0), 0)} existing steps will be deleted`
            : ""}
        </Panel>
      ) : null}

      {blocked.length ? (
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--red)", marginBottom: 4 }}>{blocked.length} will be skipped</div>
          <Panel style={{ maxHeight: 112, overflowY: "auto", borderColor: "var(--red)", background: "var(--red-bg)", fontSize: 12.5 }}>
            {blocked.map((p) => (
              <div key={p.targetId}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nameOf(p.targetId)}</div>
                <div style={{ color: "var(--red)" }}>{p.error ?? p.plan?.warnings[0] ?? "Cannot be written to"}</div>
              </div>
            ))}
          </Panel>
        </div>
      ) : null}
    </DialogFrame>
  );
}

/*
 * Choose several campaigns to push a sequence into — the tool's
 * `components/analytics/campaign-multi-picker.tsx`.
 *
 * Searching matches ANYWHERE in the name, not just the prefix — these campaigns
 * are named "<Client> + Nicole + <Market>", so the part that distinguishes them
 * is at the end, which is precisely where prefix matching and native select
 * type-ahead both give up.
 *
 * Selections stay visible as removable chips. "12 selected" would force you to
 * reopen the list to find out what you are about to write to.
 */
export function CampaignMultiPicker({
  options,
  value,
  onChange,
}: {
  options: CampaignOption[];
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  const q = search.trim().toLowerCase();
  const shown = q ? options.filter((c) => c.name.toLowerCase().includes(q)) : options;
  const chosen = options.filter((c) => value.includes(c.id));

  function toggle(id: number) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <button
        ref={trigger}
        type="button"
        className="sel"
        role="combobox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}
      >
        <span className={chosen.length ? undefined : "mut"} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {chosen.length ? `${chosen.length} campaign${chosen.length === 1 ? "" : "s"} selected` : "Choose campaigns…"}
        </span>
        <span aria-hidden className="mut">⇅</span>
      </button>
      <AnchoredPanel anchorRef={trigger} open={open} onClose={close} width={440} align="start" label="Choose campaigns">
        <div style={{ padding: 8, borderBottom: "1px solid var(--line-soft)" }}>
          <input
            className="inp"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns…"
            aria-label="Search campaigns"
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ maxHeight: 280, overflowY: "auto", padding: 4 }}>
          {shown.length === 0 ? (
            <div className="mut" style={{ padding: 20, textAlign: "center", fontSize: 12.5 }}>No campaigns match</div>
          ) : (
            shown.map((c) => (
              <label
                key={c.id}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontSize: 12.5 }}
              >
                <input type="checkbox" checked={value.includes(c.id)} onChange={() => toggle(c.id)} style={{ accentColor: "var(--blue)" }} />
                <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                <span className="mut" style={{ flex: "none", fontSize: 12 }}>{c.status}</span>
              </label>
            ))
          )}
        </div>
      </AnchoredPanel>

      {chosen.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 112, overflowY: "auto" }}>
          {chosen.map((c) => (
            <span key={c.id} className="schip" style={{ maxWidth: "100%" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
              <button
                type="button"
                onClick={() => toggle(c.id)}
                aria-label={`Remove ${c.name}`}
                style={{ border: 0, background: "none", cursor: "pointer", color: "var(--muted)", padding: 0, font: "inherit" }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
