"use client";

import { useCallback, useRef, useState } from "react";

import {
  BILLING_WINDOW_OPTIONS,
  DATE_PRESETS,
  FILTER_TABS,
  PLAN_OPTIONS,
  TZ_OPTIONS,
  presetRange,
  type BillingWindow,
  type DatePreset,
  type Filter,
  type FilterState,
} from "@/lib/tools/client-health/filters";
import { AnchoredPanel } from "@/components/ui/anchored-panel";

/*
 * The filter row, shared by all three Client Health screens.
 *
 * Shared because the tool shares it: one `visible` list feeds Weekly,
 * Bi-Weekly and Client Success, so a plan filter set on one is set on all
 * three. Three copies of this would be three chances for "At Risk" to mean
 * something slightly different depending on which tab you were on.
 *
 * Six controls, in the tool's order: search, the nine status pills, plan, time
 * zone, billing window, and a start-date range behind a popover. The three
 * selects and the date pill light up when they are narrowing anything — a
 * filter you cannot see is a filter you will forget you set, and then the
 * screen is simply missing clients.
 */

export interface FilterBarState extends FilterState {
  tz: string;
  billingWindow: BillingWindow;
  dateFrom: string | null;
  dateTo: string | null;
  /** Which preset produced the current range, or "custom", or null. */
  datePreset: DatePreset | "custom" | null;
}

export const EMPTY_FILTERS: FilterBarState = {
  search: "",
  filter: "all",
  plan: "all",
  tz: "all",
  billingWindow: "all",
  dateFrom: null,
  dateTo: null,
  datePreset: null,
};

const on = (active: boolean): React.CSSProperties =>
  active
    ? { cursor: "pointer", borderColor: "var(--blue)", color: "var(--blue-ink)", fontWeight: 600 }
    : { cursor: "pointer" };

export function FilterBar({
  value,
  onChange,
  now,
  /** Weekly shows the plan select; the other two views have a Plan column. */
  showPlan = true,
}: {
  value: FilterBarState;
  onChange: (next: FilterBarState) => void;
  now: Date;
  showPlan?: boolean;
}) {
  const set = <K extends keyof FilterBarState>(k: K, v: FilterBarState[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <input
        className="inp"
        placeholder="Search clients…"
        value={value.search}
        onChange={(e) => set("search", e.target.value)}
        aria-label="Search clients"
        type="search"
      />

      {showPlan ? (
        <select
          className="inp"
          value={value.plan}
          onChange={(e) => set("plan", e.target.value)}
          aria-label="Filter by plan"
          title="Filter by plan"
          style={on(value.plan !== "all")}
        >
          {PLAN_OPTIONS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      ) : null}

      <select
        className="inp"
        value={value.tz}
        onChange={(e) => set("tz", e.target.value)}
        aria-label="Filter by time zone"
        title="Filter by time zone"
        style={on(value.tz !== "all")}
      >
        {TZ_OPTIONS.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>

      <select
        className="inp"
        value={value.billingWindow}
        onChange={(e) => set("billingWindow", e.target.value as BillingWindow)}
        aria-label="Filter by next billing date"
        title="Filter by next billing date"
        style={on(value.billingWindow !== "all")}
      >
        {BILLING_WINDOW_OPTIONS.map((b) => (
          <option key={b.id} value={b.id}>{b.label}</option>
        ))}
      </select>

      <DateFilter value={value} onChange={onChange} now={now} />

      <span className="pills">
        {FILTER_TABS.map((f) => (
          <button
            key={f.id}
            className={`fp${f.cls ? ` ${f.cls}` : ""}${value.filter === f.id ? " on" : ""}`}
            onClick={() => set("filter", f.id as Filter)}
            aria-pressed={value.filter === f.id}
            title={f.title}
          >
            {f.label}
          </button>
        ))}
      </span>
    </div>
  );
}

const PRESET_LABEL: Record<DatePreset, string> = {
  last7: "Last 7 days",
  last30: "Last 30 days",
  ytd: "Year to date",
};

/*
 * The start-date range.
 *
 * Behind a popover because it is four controls for a filter most people never
 * touch, and putting all four on the row would make the four that matter
 * harder to find. The pill states the current range when one is set, so a
 * closed popover still says what it is doing.
 */
function DateFilter({
  value,
  onChange,
  now,
}: {
  value: FilterBarState;
  onChange: (next: FilterBarState) => void;
  now: Date;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  /*
   * Dismissal — outside click and Escape — now lives in AnchoredPanel, and it
   * HAS to. The panel is portalled to <body>, so a handler asking "is the
   * click inside my wrapper?" answers no for every click inside the panel
   * itself and shuts it the instant you touch a date field.
   */

  const label =
    value.datePreset === "custom"
      ? `${value.dateFrom ?? "…"} → ${value.dateTo ?? "…"}`
      : value.datePreset
        ? PRESET_LABEL[value.datePreset]
        : "Start date";

  const applyPreset = (p: DatePreset) => {
    const { from, to } = presetRange(p, now);
    onChange({ ...value, dateFrom: from, dateTo: to, datePreset: p });
  };

  const setBound = (which: "dateFrom" | "dateTo", raw: string) => {
    const next = { ...value, [which]: raw || null };
    // Any hand-edit makes the range custom; clearing both clears the filter.
    next.datePreset = next.dateFrom || next.dateTo ? "custom" : null;
    onChange(next);
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={trigger}
        className="btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Filter by client start date"
        style={value.datePreset ? { borderColor: "var(--blue)", color: "var(--blue-ink)", fontWeight: 600 } : undefined}
      >
        {label}
      </button>

      {/*
        Portalled: this bar sits in a scrolling toolbar, and an absolutely
        positioned panel inside it was clipped to nothing — 0% of a 250x372
        panel was on screen. See ui/anchored-panel.tsx.
      */}
      <AnchoredPanel
        anchorRef={trigger}
        open={open}
        onClose={close}
        width={250}
        align="end"
        label="Filter by start date"
      >
        <div style={{ padding: 14, overflowY: "auto", flex: 1, minHeight: 0 }}>
          <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
            {DATE_PRESETS.map((p) => (
              <button
                key={p.id}
                className="btn"
                onClick={() => applyPreset(p.id)}
                style={{
                  justifyContent: "flex-start",
                  ...(value.datePreset === p.id
                    ? { borderColor: "var(--blue)", color: "var(--blue-ink)", fontWeight: 600 }
                    : {}),
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          <label style={{ display: "block", marginBottom: 10 }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>
              From
            </span>
            <input
              className="inp tnum"
              style={{ width: "100%", boxSizing: "border-box" }}
              type="date"
              value={value.dateFrom ?? ""}
              onChange={(e) => setBound("dateFrom", e.target.value)}
            />
          </label>

          <label style={{ display: "block", marginBottom: 14 }}>
            <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>
              To
            </span>
            <input
              className="inp tnum"
              style={{ width: "100%", boxSizing: "border-box" }}
              type="date"
              value={value.dateTo ?? ""}
              onChange={(e) => setBound("dateTo", e.target.value)}
            />
          </label>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn"
              style={{ flex: 1 }}
              onClick={() => {
                onChange({ ...value, dateFrom: null, dateTo: null, datePreset: null });
                setOpen(false);
              }}
            >
              Clear
            </button>
            <button className="btn btn-pri" style={{ flex: 1 }} onClick={close}>
              Done
            </button>
          </div>
        </div>
      </AnchoredPanel>
    </div>
  );
}
