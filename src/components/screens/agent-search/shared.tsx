"use client";

import { useEffect, useState } from "react";

import { ALL_COLUMNS, KEY_COLUMNS, type SourceId } from "@/lib/tools/agent-search/columns";
import type { CourtedState } from "@/lib/tools/agent-search/courted-state";
import { cellKind, countLabel } from "@/lib/tools/agent-search/format";
import type { JobStatus, SourceState } from "./job-store";

/*
 * The pieces every Agent Search screen shares, written against the design's
 * own vocabulary in workspace.css — .as-hd, .as-card, .as-btn, .as-tog,
 * .as-res, .as-cnt, .as-body. Nothing here imports anything from the tool's
 * stylesheet; the tool is Tailwind-free vanilla CSS on a dark shell, and this
 * is the workspace's light one.
 */

/* ------------------------------------------------------------------ header */

export interface StatusInfo {
  courted: boolean;
  courtedAccounts: number;
  unblocker: string | null;
}

/**
 * The tool's own header badges: which Courted accounts are loaded and which
 * unblocker is active. Green when present, muted when not — matching
 * app.js's `ok()` helper, which prints ● or ○.
 */
export function AgentSearchHeader(
  { title, sub, status }: { title: string; sub: string; status: StatusInfo | null },
) {
  return (
    <div className="as-hd">
      <div className="as-logo" aria-hidden><i /></div>
      <div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      {status ? (
        <div className="as-stat">
          <Badge
            on={status.courted}
            label={status.courtedAccounts > 1 ? `Courted · ${status.courtedAccounts} accts` : "Courted"}
          />
          <Badge
            on={Boolean(status.unblocker)}
            label={`Unblocker${status.unblocker ? ` · ${status.unblocker}` : ""}`}
          />
        </div>
      ) : null}
    </div>
  );
}

function Badge({ on, label }: { on: boolean; label: string }) {
  return (
    <span style={on ? undefined : { color: "var(--muted)", background: "var(--inset-2)" }}>
      <i /> {label}
    </span>
  );
}

/** Polls nothing — one read, shared by whichever screens are mounted. */
export function useStatus(): StatusInfo | null {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/tools/agent-search/status", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((s: StatusInfo) => { if (live) setStatus(s); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return status;
}

/* ------------------------------------------------------ long-running jobs */

/** A fire-and-poll route's early answer: the upstream refused or finished. */
export interface FireReply {
  error?: string;
  ok?: boolean;
  message?: string;
  started?: boolean;
  pending?: boolean;
}

/**
 * Watch GET courted-state until `done` says the job's result has landed.
 *
 * The refresh and the monitor resolve upstream only when a multi-hour sweep
 * finishes, so the workspace's routes answer 202 `{ started }` and the proof
 * of completion is the row the scheduler writes — `refresh_state` for a
 * re-scrape, `mls_monitor_state` for the monitor. Fifteen seconds between
 * looks: the runs take minutes to hours, and the read is a two-table select.
 * A failed poll is "still running", not an error — the same rule as
 * `waitForAccounts`. Resolves null when `maxMs` passes with no result.
 */
export function pollCourtedState(
  done: (s: CourtedState) => boolean,
  opts: { intervalMs?: number; maxMs?: number; onTick?: (elapsedMs: number) => void } = {},
): Promise<CourtedState | null> {
  const { intervalMs = 15_000, maxMs = 8 * 60 * 60 * 1000, onTick } = opts;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      fetch("/api/tools/agent-search/courted-state", { cache: "no-store", credentials: "same-origin" })
        .then((r) => r.json())
        .then((s: CourtedState) => {
          if (!s.error && done(s)) { resolve(s); return; }
          again();
        })
        .catch(again);
    };
    const again = () => {
      const elapsed = Date.now() - t0;
      if (elapsed >= maxMs) { resolve(null); return; }
      onTick?.(elapsed);
      setTimeout(tick, intervalMs);
    };
    setTimeout(tick, intervalMs);
  });
}

/** "4 min", "1 h 12 min" — for a "still running" line. */
export function elapsedLabel(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} min`;
}

/*
 * The per-source column lists.
 *
 * Starts from the ported constants so a table has a header on first paint,
 * then upgrades if the live service answers — the same order the tool does it
 * in, for the same reason.
 */
export function useColumns(): Record<SourceId, readonly string[]> {
  const [cols, setCols] = useState<Record<SourceId, readonly string[]>>(ALL_COLUMNS);
  useEffect(() => {
    let live = true;
    fetch("/api/tools/agent-search/columns", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((c: Partial<Record<SourceId, string[]>>) => {
        if (live && c && Array.isArray(c.courted)) {
          setCols({ courted: c.courted, zillow: c.zillow ?? ALL_COLUMNS.zillow, realtor: c.realtor ?? ALL_COLUMNS.realtor });
        }
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return cols;
}

export function displayColumns(
  cols: Record<SourceId, readonly string[]>, source: SourceId, showAll: boolean,
): readonly string[] {
  return showAll ? cols[source] : KEY_COLUMNS[source];
}

/* ------------------------------------------------------------------- cards */

export function Card(
  { title, small, sub, children }:
  { title: string; small?: string; sub?: string; children: React.ReactNode },
) {
  return (
    <section className="as-card">
      <h2>{title}{small ? <small>{small}</small> : null}</h2>
      {sub ? <p className="sub">{sub}</p> : null}
      {children}
    </section>
  );
}

/**
 * A status line under a card's controls.
 *
 * `tone="error"` is red — the tool's `.msg.error`. Errors here are the whole
 * answer ("Courted login failed — check the credentials"), so they get room
 * rather than a toast that disappears.
 */
export function Msg({ text, tone }: { text: string; tone?: "error" | "ok" }) {
  if (!text) return null;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      style={{
        marginTop: 14, fontSize: 13, lineHeight: 1.6,
        color: tone === "error" ? "var(--red)" : "var(--muted)",
      }}
    >
      {text}
    </div>
  );
}

export function Actions({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 18 }}>
      {children}
    </div>
  );
}

export function Field(
  { label, hint, children }: { label: string; hint?: string; children: React.ReactNode },
) {
  return (
    <label style={{ display: "block", minWidth: 0 }}>
      <span className="as-l">
        {label}{hint ? <span style={{ color: "var(--muted)", fontWeight: 400 }}> {hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

/** A checkbox in the design's idiom — the tool's `.chk small`. */
export function Check(
  { checked, onChange, label, hint, disabled }:
  { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean },
) {
  return (
    <label style={{
      display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13,
      color: "var(--ink-2)", cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
    }}>
      <input
        type="checkbox" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ cursor: "inherit", accentColor: "var(--blue)" }}
      />
      <span>{label}</span>
      {hint ? <span style={{ color: "var(--muted)" }}>{hint}</span> : null}
    </label>
  );
}

/* ----------------------------------------------------------- result panels */

const TONE: Record<SourceId, string> = { courted: "g", zillow: "b", realtor: "y" };

export const SOURCE_LABEL: Record<SourceId, string> = {
  courted: "Courted",
  zillow: "Zillow",
  realtor: "Realtor.com",
};

/**
 * One source's live results.
 *
 * The count reads "fetched / total" once a total is known, and prefers the
 * SERVER's count over the rendered row count — on a full sweep the rows go
 * straight to the database and never reach this table, so counting <tr>s
 * would show 0 for an hour. That is `countLabel`, ported from app.js.
 */
export function ResultPanel(
  { source, state, columns, onExport, dim }:
  {
    source: SourceId; state: SourceState; columns: readonly string[];
    onExport?: () => void;
    /**
     * Fade this panel back.
     *
     * The tool dims a source that is not in the current run rather than hiding
     * it, so the layout does not jump when a run starts. Left to
     * `state.active` this was true for all three panels until someone pressed
     * Search — an opening screen where every panel looked switched off. The
     * caller decides now: the toggles at rest, the run once there is one.
     */
    dim?: boolean;
  },
) {
  const count = countLabel(state.rows.length, state.serverCount, state.total);
  const hasRows = state.rows.length > 0;
  return (
    <div
      className={`as-res ${TONE[source]}${dim ? " as-dim" : ""}${hasRows ? " as-has-rows" : ""}`}
    >
      <div className="as-res-h">
        <h3>{SOURCE_LABEL[source]}</h3>
        <StatusPill status={state.status} />
        <span className="as-cnt tnum">{count}</span>
        {/*
          Always rendered, disabled until there is something to export — the
          design shows this button on every panel. Building it only once a job
          existed meant the panel headers silently changed shape the moment a
          search started, and there was no affordance beforehand to say an
          export was ever going to be possible.
        */}
        <button
          className="as-btn ghost" onClick={onExport}
          disabled={!onExport || !hasRows}
          title={hasRows ? "Download these rows as CSV" : "Nothing to export yet"}
        >
          Export CSV
        </button>
      </div>
      {state.message ? (
        <div style={{
          padding: "10px 22px", fontSize: 12.5,
          color: state.status === "error" ? "var(--red)" : "var(--muted)",
          borderBottom: "1px solid var(--line-soft)",
        }}>
          {state.message}
        </div>
      ) : null}
      {state.rows.length === 0 ? (
        <div className="as-body">
          {state.status === "running"
            ? "Scraping…"
            : state.serverCount > 0
              // The honest explanation for a running total with an empty table.
              ? `${state.serverCount.toLocaleString("en-US")} agents written straight to the database — full sweeps do not fill this table.`
              : "No results yet."}
        </div>
      ) : (
        <DataTable columns={columns} rows={state.rows} />
      )}
    </div>
  );
}

export function StatusPill({ status }: { status: JobStatus }) {
  const tone: Record<JobStatus, React.CSSProperties> = {
    idle: {},
    queued: {},
    running: { color: "var(--blue-ink)", background: "var(--blue-pale)" },
    done: { color: "var(--green)", background: "var(--green-pale)" },
    stopped: {},
    error: { color: "var(--red)", background: "var(--red-pale)" },
  };
  return <span className="as-idle" style={tone[status]}>{status}</span>;
}

/* ------------------------------------------------------------------ tables */

/**
 * A scrolling table of scraped rows.
 *
 * Always inside its own overflow-x container: the full Courted set is 77
 * columns, so this WILL be wider than the window and must scroll itself
 * rather than pushing the page sideways.
 */
export function DataTable(
  { columns, rows, minWidth }:
  { columns: readonly string[]; rows: Record<string, unknown>[]; minWidth?: number },
) {
  return (
    <div className="tbl-scroll">
      <table className="atbl" style={{ minWidth: minWidth ?? Math.max(720, columns.length * 132) }}>
        <thead>
          <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => <Cell key={c} col={c} value={row[c]} />)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Link / money / text, by the tool's own rules — see format.cellKind. */
export function Cell({ col, value }: { col: string; value: unknown }) {
  const k = cellKind(col, value);
  if (k.kind === "empty") return <td />;
  if (k.kind === "link") {
    return (
      <td>
        <a href={k.href} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>link</a>
      </td>
    );
  }
  if (k.kind === "money") return <td className="tnum" title={k.text}>{k.text}</td>;
  return <td title={k.text} style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.text}</td>;
}

/** Download a client-side string as a file. */
export function download(name: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** A short relative stamp — "3 days ago". */
export function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
