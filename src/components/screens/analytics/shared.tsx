"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AnchoredPanel } from "@/components/ui/anchored-panel";

import { pathForId } from "@/lib/workspace/nav";

import { StalenessStrip } from "./staleness-strip";
import { DIM } from "./toast";

/*
 * The pieces every Analytics screen shares, written against the design's own
 * vocabulary in workspace.css — `.an-tabs`, `.an-tab`, `.an-filter`, `.kpi`,
 * `.seg`, `.segfull`, `.abox`, `.atbl`, `.schip`, `.qr`, `.gh`, `.bar-h`,
 * `.stack`. Nothing here imports anything from the tool's stylesheet; the tool
 * is Tailwind on shadcn, and this is the workspace's own light theme.
 */

/* ------------------------------------------------------------------ panels */

/** The design's `.abox` — a bordered card with a titled header row. */
export function Box({
  title,
  note,
  right,
  children,
  style,
}: {
  title: string;
  note?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  /*
   * The design's `.abox-h` is one row: the title on the left, the meta pushed
   * to the right by `justify-content:space-between`, on the SAME baseline.
   *
   * This used to wrap the title and the note in a div, which stacked the note
   * UNDER the title and left `space-between` pushing that block against the
   * controls. Every card on every Analytics screen was a line taller than the
   * design and read as a page heading rather than a card header. The note is
   * now a sibling `.note`, exactly as the mockup writes it.
   */
  return (
    <section className="abox" style={{ marginBottom: 20, ...style }}>
      <div className="abox-h">
        <h2>{title}</h2>
        {note ? <span className="note">{note}</span> : null}
        {right ? (
          <span className="an-head-tools">{right}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The in-pane tab strip the design draws at the top of the four Analytics
 * report screens — `.an-tabs` / `.an-tab` in workspace.css.
 *
 * WHY IT EXISTS HERE even though the left rail already lists the same four
 * leaves: the mockup's own annotation on `#an-campaign` says, of the tool's
 * 212px sidebar being hoisted into the rail, "**Kept:** the tab strip and the
 * filter bar". The design's author considered exactly this overlap and decided
 * the strip survives it — these four are one report read four ways, and moving
 * between them is a within-task move, not a change of place. The rail answers
 * "where am I in the workspace"; this answers "which cut of this report".
 *
 * Only the report screens get it. Campaigns, Schedule and Clients are
 * separate destinations and the mockup draws no strip on them either.
 *
 * Five tabs, in the tool's own order (tab-bar.tsx): Volume sits second, between
 * Campaign and Infrastructure. It used to be a fifth sub-view inside the
 * Campaign screen; it is its own screen again because that is what the tool
 * ships.
 *
 * The staleness strip rides above the tabs so that every screen with a tab
 * strip carries it without each one having to remember to mount it.
 */
const AN_TABS: ReadonlyArray<{ id: AnalyticsTab; label: string }> = [
  { id: "campaign", label: "Campaign" },
  { id: "volume", label: "Volume" },
  { id: "infrastructure", label: "Infrastructure" },
  { id: "attribution", label: "Attribution" },
  { id: "copy", label: "Copy & Offer" },
];

export type AnalyticsTab = "campaign" | "volume" | "infrastructure" | "attribution" | "copy";

export function AnalyticsTabs({ active }: { active: AnalyticsTab }) {
  return (
    <>
      <StalenessStrip />
      <nav className="an-tabs" aria-label="Analytics views">
        {AN_TABS.map((t) => (
          <Link
            key={t.id}
            href={pathForId(`analytics:${t.id}`)}
            className={`an-tab${t.id === active ? " on" : ""}`}
            aria-current={t.id === active ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </>
  );
}

/** A segmented control in the design's `.seg`. */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  full,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; count?: number }>;
  onChange: (next: T) => void;
  /** `.segfull` — stretches across the stage, used for a screen's sub-view. */
  full?: boolean;
  label: string;
}) {
  return (
    <div className={full ? "segfull" : "seg"} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? "on" : ""}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined ? (
            <span className="mut" style={{ marginLeft: 6, fontWeight: 500 }}>
              {o.count.toLocaleString("en-US")}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** A checkbox in the design's idiom. */
export function Check({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13,
        color: "var(--ink-2)", cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1, whiteSpace: "nowrap",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ cursor: "inherit", accentColor: "var(--blue)" }}
      />
      <span>{label}</span>
      {hint ? <span className="mut">{hint}</span> : null}
    </label>
  );
}

/* ------------------------------------------------------------------ tables */

export type SortDir = "asc" | "desc";
export interface SortState { key: string; dir: SortDir }

/**
 * Three-click sorting: ascending, descending, back to the server's order.
 *
 * The third state is not a nicety. Every one of these tables arrives sorted by
 * the thing that matters (volume, outcomes, sends), and a two-state header
 * makes that order unrecoverable without a reload.
 */
export function useSort(initial: SortState | null = null) {
  const [sort, setSort] = useState<SortState | null>(initial);
  const toggle = (key: string) =>
    setSort((s) =>
      !s || s.key !== key ? { key, dir: "desc" } : s.dir === "desc" ? { key, dir: "asc" } : null,
    );
  return { sort, toggle, setSort };
}

export function SortHeader({
  label,
  sortKey,
  sort,
  onToggle,
  align,
  width,
  title,
}: {
  label: string;
  sortKey: string;
  sort: SortState | null;
  onToggle: (key: string) => void;
  align?: "right";
  width?: number;
  title?: string;
}) {
  const on = sort?.key === sortKey;
  return (
    <th style={{ width, textAlign: align === "right" ? "right" : "left" }}
        aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        title={title ?? `Sort by ${label}`}
        style={{
          border: 0, background: "none", font: "inherit", color: on ? "var(--ink)" : "inherit",
          fontWeight: on ? 600 : 500, cursor: "pointer", padding: 0,
          display: "inline-flex", alignItems: "center", gap: 4,
        }}
      >
        {label}
        <span className="sort-ico" style={{ opacity: on ? 0.9 : 0.28 }}>
          {on ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

/** Sorts rows by a comparable extracted per row. Nulls always sort last. */
export function sortRows<T>(
  rows: T[],
  sort: SortState | null,
  valueOf: (row: T, key: string) => number | string | null | undefined,
): T[] {
  if (!sort) return rows;
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = valueOf(a, sort.key);
    const bv = valueOf(b, sort.key);
    // A missing value is not "smallest" — it is unknown, and unknown belongs at
    // the bottom whichever way the arrow points.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv)) * dir;
    }
    return (av - bv) * dir;
  });
}

/** The empty row every table uses — a colSpan cell, never a component. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
        {children}
      </td>
    </tr>
  );
}

/* ---------------------------------------------------------------- controls */

/** A search box that only tells its caller after the typing stops. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return held;
}

export function Search({
  value,
  onChange,
  placeholder,
  width = 240,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  width?: number;
}) {
  return (
    <input
      className="inp"
      type="search"
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{ minWidth: width, width }}
    />
  );
}

/**
 * The column picker.
 *
 * Persisted to localStorage under the tool's own key and version, so a person
 * moving between the two sees the same columns. A version bump discards the
 * stored set rather than letting a stale preference hide a new column forever.
 */
export function useColumnPrefs(key: string, version: number, defaults: string[]) {
  const [visible, setVisible] = useState<string[]>(defaults);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const saved = JSON.parse(raw) as { version?: number; visible?: string[] };
      if (saved.version === version && Array.isArray(saved.visible) && saved.visible.length) {
        setVisible(saved.visible);
      }
    } catch {
      // A corrupt preference is not worth an error state; the defaults are fine.
    }
  }, [key, version]);

  const set = (next: string[]) => {
    setVisible(next);
    try {
      window.localStorage.setItem(key, JSON.stringify({ version, visible: next }));
    } catch {
      // Private browsing. The choice just does not persist.
    }
  };

  return [visible, set] as const;
}

export function ColumnPicker({
  groups,
  columns,
  visible,
  onChange,
}: {
  groups: readonly string[];
  columns: ReadonlyArray<{ key: string; label: string; group: string }>;
  visible: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const byGroup = useMemo(() => {
    const out = new Map<string, Array<{ key: string; label: string }>>();
    for (const c of columns) {
      const list = out.get(c.group) ?? [];
      list.push({ key: c.key, label: c.label });
      out.set(c.group, list);
    }
    return out;
  }, [columns]);

  return (
    <span style={{ position: "relative" }}>
      <button
        ref={trigger}
        type="button" className="gh" aria-expanded={open} onClick={() => setOpen((v) => !v)}
      >
        Columns <span className="cpill">{visible.length}</span>
      </button>
      {/*
        Portalled: this picker sits in a table toolbar inside `.tbl-scroll`,
        which clips. See ui/anchored-panel.tsx.
      */}
      <AnchoredPanel
        anchorRef={trigger} open={open} onClose={close}
        width={300} align="end" label="Choose columns"
      >
        <div style={{ padding: 12, overflowY: "auto", flex: 1, minHeight: 0 }}>
          {groups.map((g) => (
            <div key={g} style={{ marginBottom: 12 }}>
              <div className="grp-h" style={{ padding: "0 0 6px" }}>{g}</div>
              {(byGroup.get(g) ?? []).map((c) => (
                <label
                  key={c.key}
                  style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", fontSize: 13, cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={visible.includes(c.key)}
                    style={{ accentColor: "var(--blue)", cursor: "pointer" }}
                    onChange={() =>
                      onChange(
                        visible.includes(c.key)
                          ? visible.filter((k) => k !== c.key)
                          : [...visible, c.key],
                      )
                    }
                  />
                  {c.label}
                </label>
              ))}
            </div>
          ))}
          <button type="button" className="btn" style={{ width: "100%" }} onClick={close}>
            Done
          </button>
        </div>
      </AnchoredPanel>
    </span>
  );
}

/* ------------------------------------------------------------------- misc */

/** A horizontal bar, in the design's `.bar-h`. */
export function Bar({ fraction, color }: { fraction: number; color: string }) {
  return (
    <div className="bar-h" style={{ height: 12 }}>
      <i style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%`, background: color }} />
    </div>
  );
}

/** The failure ribbon every screen shows instead of zeros. */
export function LoadError({ what, error }: { what: string; error: string }) {
  return (
    <div className="wrap">
      <div className="anno" style={{ margin: "0 0 18px" }}>
        <b>{what} could not be loaded.</b> {error}. The live Analytics app is unaffected — this is
        the workspace&rsquo;s own connection to its database.
      </div>
    </div>
  );
}

/** A pager for a server-paged list. */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (next: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const lo = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const hi = Math.min(total, page * pageSize);
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "13px 18px",
        borderTop: "1px solid var(--line-soft)", fontSize: 13, color: "var(--muted)",
      }}
    >
      <span className="tnum">
        {lo.toLocaleString("en-US")}–{hi.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button" className="btn" disabled={page <= 1}
        style={page <= 1 ? DIM : undefined}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </button>
      <span className="tnum">{page} / {pages}</span>
      <button
        type="button" className="btn" disabled={page >= pages}
        style={page >= pages ? DIM : undefined}
        onClick={() => onPage(page + 1)}
      >
        Next
      </button>
    </div>
  );
}
