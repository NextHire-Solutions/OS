"use client";

import { useMemo, useState } from "react";

import {
  linkPreviewCount,
  linkPreviewText,
  parseIntervalDays,
  toPayload,
  withPlan,
  type ClientFormState,
  type NamedCampaign,
} from "@/lib/tools/client-health/clientForm";
import {
  BILLING_INTERVAL_LABEL,
  PLAN_DEFAULT_TARGET,
  TIME_ZONES,
  type BillingInterval,
  type Plan,
} from "@/lib/tools/client-health/types";

import { Dialog, DialogBody, DialogFoot, DialogHead, Field } from "./dialog";
import { saveClient } from "./mutations";

/*
 * Add / Edit client — every field the tool's modal has.
 *
 * The rules live in lib/clientForm.ts, not here; this is the markup and the
 * one piece of state that has to be local, which is the in-flight save. What
 * is worth reading in this file is what the controls DO:
 *
 *   the name field previews its auto-linking as you type, so you find out
 *   that no campaign matches before you save rather than by wondering why
 *   the new row is empty.
 *
 *   changing plan moves the weekly target only while it is still a default.
 *
 *   the custom-days input appears only for the Custom interval, and stays
 *   free text until save.
 *
 * Save is disabled on an empty name — the tool lets you press it and silently
 * does nothing, which is the same outcome with a worse explanation.
 */

const PLAN_OPTIONS: { id: Plan; label: string }[] = [
  { id: "minimum", label: `Minimum — ${PLAN_DEFAULT_TARGET.minimum} intro/week` },
  { id: "production", label: `Production — ${PLAN_DEFAULT_TARGET.production} intros/week` },
  { id: "partner", label: `Partner — ${PLAN_DEFAULT_TARGET.partner} intros/week` },
];

const INTERVALS: BillingInterval[] = ["biweekly", "28-days", "monthly", "custom"];

const input: React.CSSProperties = { width: "100%", boxSizing: "border-box" };

export function ClientModal({
  form: initial,
  instantly,
  bison,
  onClose,
}: {
  form: ClientFormState;
  instantly: NamedCampaign[];
  bison: NamedCampaign[];
  onClose: () => void;
}) {
  const [form, setForm] = useState<ClientFormState>(initial);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof ClientFormState>(k: K, v: ClientFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const linked = useMemo(
    () => linkPreviewCount(form.name, instantly, bison),
    [form.name, instantly, bison],
  );

  const named = form.name.trim().length > 0;

  async function submit() {
    if (!named || saving) return;
    setSaving(true);
    const ok = await saveClient(form.editingId, toPayload(form, instantly, bison));
    setSaving(false);
    if (ok) onClose();
  }

  return (
    <Dialog onClose={onClose} labelledBy="ch-modal-title" width={540}>
      <DialogHead
        id="ch-modal-title"
        title={form.editingId ? "Edit Client" : "Add Client"}
        sub={
          form.editingId
            ? "Update this client’s details."
            : "Enter the client’s details to start tracking."
        }
      />

      <DialogBody>
        <Field label="Client / Brokerage Name" help={linkPreviewText(form.name, linked)}>
          <input
            className="inp"
            style={input}
            value={form.name}
            placeholder="e.g. Premier Metro Realty"
            onChange={(e) => set("name", e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          />
        </Field>

        <Field label="Plan">
          <select
            className="inp"
            style={{ ...input, cursor: "pointer" }}
            value={form.plan}
            onChange={(e) => setForm((f) => withPlan(f, e.target.value as Plan))}
          >
            {PLAN_OPTIONS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </Field>

        <Field
          label="Weekly Intros Target"
          help="Drives the At Risk / On Track status. Defaults to the plan tier, but you can override it."
        >
          <input
            className="inp tnum"
            style={input}
            type="number"
            min={0}
            value={form.weeklyTarget}
            onChange={(e) => set("weeklyTarget", parseInt(e.target.value || "0", 10))}
          />
        </Field>

        <Field
          label="Monthly Intros Target"
          help="Progress resets on the client’s billing anchor day each month. 0 leaves the Monthly column blank."
        >
          <input
            className="inp tnum"
            style={input}
            type="number"
            min={0}
            value={form.monthlyTarget}
            onChange={(e) => set("monthlyTarget", parseInt(e.target.value || "0", 10))}
          />
        </Field>

        <Field label="Start Date">
          <input
            className="inp tnum"
            style={input}
            type="date"
            value={form.startDate}
            onChange={(e) => set("startDate", e.target.value)}
          />
        </Field>

        <Field label="Billing Anchor Date" help="A known billing date. Empty falls back to the start date.">
          <input
            className="inp tnum"
            style={input}
            type="date"
            value={form.billingAnchorDate}
            onChange={(e) => set("billingAnchorDate", e.target.value)}
          />
        </Field>

        <Field label="Billing Interval">
          <select
            className="inp"
            style={{ ...input, cursor: "pointer" }}
            value={form.billingInterval}
            onChange={(e) => set("billingInterval", e.target.value as BillingInterval)}
          >
            {INTERVALS.map((i) => (
              <option key={i} value={i}>{BILLING_INTERVAL_LABEL[i]}</option>
            ))}
          </select>

          {form.billingInterval === "custom" ? (
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 10,
                fontSize: 13,
                color: "var(--ink-2)",
              }}
            >
              Every
              <input
                className="inp tnum"
                style={{ width: 88 }}
                type="number"
                min={1}
                step={1}
                placeholder="21"
                value={form.billingIntervalDays}
                onChange={(e) => set("billingIntervalDays", e.target.value)}
                aria-label="Custom billing interval, in days"
              />
              days
              {/* Said here rather than on save: an interval that will not
                  compute is worth knowing about before the dialog closes. */}
              {form.billingIntervalDays && parseIntervalDays(form) === null ? (
                <span style={{ color: "var(--red)", fontSize: 12.5 }}>
                  needs a whole number of days
                </span>
              ) : null}
            </span>
          ) : null}
        </Field>

        <Field label="Time Zone" help="Shown as a short code (ET, PT, …) in every view.">
          <select
            className="inp"
            style={{ ...input, cursor: "pointer" }}
            value={form.timeZone}
            onChange={(e) => set("timeZone", e.target.value)}
          >
            <option value="">— None —</option>
            {TIME_ZONES.map((tz) => (
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
          </select>
        </Field>

        {/*
          §8 lists Aliases as a field of the Client Health view. Read-only on
          purpose: this tool matches campaigns by name, so the aliases matter
          here, but §7 wants ONE place to edit a field — the client record in
          the OS, which writes this column, Analytics and os_clients together.
          A second editor here is how the three copies drifted apart before.
        */}
        <Field
          label="Also known as"
          help="Edited on the client record in Clients — saving there updates this tool, Analytics and the master together."
        >
          {form.aliases.length === 0 ? (
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
              No other spellings recorded. Campaigns are matched on the name above.
            </span>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {form.aliases.map((a) => (
                <span
                  key={a}
                  className="badge"
                  style={{ fontSize: 11.5, background: "var(--chip, rgba(127,127,127,.12))" }}
                >
                  {a}
                </span>
              ))}
            </div>
          )}
        </Field>
      </DialogBody>

      <DialogFoot>
        <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
        <button
          className="btn btn-pri"
          onClick={() => void submit()}
          disabled={!named || saving}
          aria-busy={saving}
          title={named ? undefined : "A client needs a name"}
          style={!named || saving ? { opacity: 0.6, cursor: "not-allowed" } : undefined}
        >
          {saving ? "Saving…" : form.editingId ? "Save Changes" : "Add Client"}
        </button>
      </DialogFoot>
    </Dialog>
  );
}
