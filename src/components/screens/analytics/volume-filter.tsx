"use client";

import { useCallback, useRef, useState } from "react";

import { AnchoredPanel } from "@/components/ui/anchored-panel";
import {
  VOLUME_PRESETS,
  parseAmountInput,
  shortAmount,
  volumeLabel,
} from "@/lib/tools/analytics/campaigns/amount-filter.ts";

import { Btn } from "./toast";

/*
 * "Sales volume from / to" on a campaign's Leads tab (9 Oct).
 *
 * A chip beside the status chips, because it is the same kind of thing: a
 * filter on the table. The range is applied in SQL (analytics 096), so it
 * holds across every page, the total, and "Select all matching".
 */
export function VolumeFilter({
  min,
  max,
  onChange,
}: {
  min: number | null;
  max: number | null;
  onChange: (next: { min: number | null; max: number | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const active = min !== null || max !== null;

  const openPanel = () => {
    // Start from what is applied, so editing a range does not mean retyping it.
    setFrom(min === null ? "" : shortAmount(min));
    setTo(max === null ? "" : shortAmount(max));
    setError(null);
    setOpen((v) => !v);
  };

  const apply = (nextMin: number | null, nextMax: number | null) => {
    onChange({ min: nextMin, max: nextMax });
    setOpen(false);
  };

  const applyTyped = () => {
    const a = parseAmountInput(from);
    const b = parseAmountInput(to);
    if (a === "invalid" || b === "invalid") {
      setError("Enter an amount like 3M, 500K or 2,500,000.");
      return;
    }
    if (a !== null && b !== null && a > b) {
      setError("“From” is more than “To”.");
      return;
    }
    apply(a, b);
  };

  return (
    <span style={{ position: "relative" }}>
      <button
        ref={trigger}
        type="button"
        className={`schip${active ? "" : " off"}`}
        aria-pressed={active}
        aria-expanded={open}
        onClick={openPanel}
      >
        {volumeLabel(min, max)} <span aria-hidden="true" style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
      </button>
      <AnchoredPanel anchorRef={trigger} open={open} onClose={close} width={300} align="start" label="Filter by sales volume">
        <form
          style={{ padding: 14, display: "grid", gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            applyTyped();
          }}
        >
          <div className="grp-h" style={{ padding: 0 }}>Sales volume</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--muted)", minWidth: 0 }}>
              From
              <input
                id="volume-filter-from"
                className="inp"
                inputMode="decimal"
                placeholder="e.g. 3M"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                style={{ width: "100%", minWidth: 0 }}
                autoFocus
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--muted)", minWidth: 0 }}>
              To
              <input
                id="volume-filter-to"
                className="inp"
                inputMode="decimal"
                placeholder="No limit"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                style={{ width: "100%", minWidth: 0 }}
              />
            </label>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {VOLUME_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`schip${min === p.min && max === null ? "" : " off"}`}
                onClick={() => apply(p.min, null)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {error ? (
            <div role="alert" style={{ fontSize: 12, color: "var(--red, #b42318)" }}>{error}</div>
          ) : null}
          <div className="mut" style={{ fontSize: 12, lineHeight: 1.4 }}>
            Leads with no sales volume on file are hidden while this is on.
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <Btn disabled={!active && !from && !to} onClick={() => apply(null, null)}>
              Clear
            </Btn>
            <Btn primary type="submit">
              Apply
            </Btn>
          </div>
        </form>
      </AnchoredPanel>
    </span>
  );
}
