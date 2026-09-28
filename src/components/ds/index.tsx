"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/*
 * The design system's React side. Every screen builds from these, so the OS
 * reads as one product rather than five tools sharing a sidebar. The styles are
 * src/app/ds.css; the reason the system exists is written at the top of it.
 */

export type Tone = "green" | "amber" | "red" | "brand" | "violet" | "muted" | "outline";

/* ------------------------------------------------------------ page header --- */
export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Tabs or a sub-navigation, drawn under the title row. */
  children?: React.ReactNode;
}) {
  return (
    <header style={{ display: "grid", gap: 14 }}>
      <div className="ds-head">
        <div style={{ minWidth: 0 }}>
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="ds-head-actions">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

/* ------------------------------------------------------------------ stats --- */
export function Stats({ children, min }: { children: React.ReactNode; min?: number }) {
  return (
    <div className="ds-stats" style={min ? { gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` } : undefined}>
      {children}
    </div>
  );
}

/**
 * One figure. With `onClick` it becomes a filter: `active` marks the one in use.
 */
export function Stat({
  label,
  value,
  sub,
  tone,
  title,
  onClick,
  active,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Exclude<Tone, "violet" | "outline">;
  title?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const cls = `ds-stat${tone ? ` t-${tone}` : ""}`;
  const inner = (
    <>
      <span className="ds-stat-l">{label}</span>
      <span className="ds-stat-v">{typeof value === "number" ? value.toLocaleString("en-US") : value}</span>
      {sub ? <span className="ds-stat-s">{sub}</span> : null}
    </>
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} aria-pressed={Boolean(active)} title={title}>
      {inner}
    </button>
  ) : (
    <div className={cls} title={title}>{inner}</div>
  );
}

/* ------------------------------------------------------------------ panel --- */
export function Panel({
  title,
  description,
  actions,
  children,
  flush,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** No body padding — for a table that runs edge to edge. */
  flush?: boolean;
}) {
  return (
    <section className="ds-panel">
      {title || actions ? (
        <div className="ds-panel-head">
          <div style={{ minWidth: 0 }}>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="ds-toolbar">{actions}</div> : null}
        </div>
      ) : null}
      {flush ? children : <div className="ds-panel-body">{children}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------ badge --- */
export function Badge({ tone, dot, title, children }: { tone?: Tone; dot?: boolean; title?: string; children: React.ReactNode }) {
  return (
    <span className={`ds-badge${tone && tone !== "muted" ? ` t-${tone}` : ""}`} title={title}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- segment --- */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: React.ReactNode; count?: number; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="ds-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)} title={o.title}>
          {o.label}
          {o.count !== undefined ? <span className="n">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <label className="ds-search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input className="ds-input" type="search" value={value} placeholder={placeholder} aria-label={label}
        onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/* ----------------------------------------------------------------- drawer --- */
/**
 * The right-hand record panel. Rendered into document.body — a panel opened
 * from inside a table row must not inherit the row's layout (the popup bug of
 * 28 Sep). Escape closes it; the page behind does not scroll.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  badges,
  actions,
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  label: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <>
      <div className="ds-scrim" onClick={onClose} />
      <aside className="ds-drawer" role="dialog" aria-modal="true" aria-label={label}>
        <div className="ds-drawer-head">
          <div className="ds-drawer-title">
            <div style={{ minWidth: 0 }}>
              <h2>{title}</h2>
              {subtitle ? <p>{subtitle}</p> : null}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {actions}
              <button type="button" className="ds-btn ghost icon" onClick={onClose} aria-label="Close">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
          </div>
          {badges ? <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>{badges}</div> : null}
        </div>
        <div className="ds-drawer-body">{children}</div>
      </aside>
    </>,
    document.body,
  );
}

export function Section({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="ds-section">
      <h3>{title}{hint ? <span>{hint}</span> : null}</h3>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ field --- */
export type FieldEditor =
  | { kind: "text"; placeholder?: string; list?: string[]; maxLength?: number }
  | { kind: "email" }
  | { kind: "number"; min?: number }
  | { kind: "date" }
  | { kind: "select"; options: { value: string; label: string }[] };

/**
 * A label / value row that edits in place. Click the value (or focus it and
 * press Enter), change it, press Enter or Save; Escape cancels. `onSave`
 * resolves on success and throws with a readable message otherwise — the
 * message is shown under the field and the old value stays.
 *
 * Without `editor` the row is read-only and says who owns the value.
 */
export function Field({
  label,
  hint,
  value,
  display,
  editor,
  onSave,
}: {
  label: string;
  /** Small text under the label — usually which system owns the value. */
  hint?: string;
  /** The raw value the editor starts from. */
  value: string | number | null;
  /** How the value reads; defaults to the raw value. */
  display?: React.ReactNode;
  editor?: FieldEditor;
  onSave?: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement & HTMLSelectElement>(null);
  // useId, not a random string: stable between server and client render.
  const listId = useId();

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(false), 1800); return () => clearTimeout(t); }, [saved]);

  const empty = value === null || value === "" || value === undefined;
  const shown = display ?? (empty ? null : String(value));

  function start() {
    if (!editor || !onSave) return;
    setDraft(empty ? "" : String(value));
    setError(null);
    setEditing(true);
  }

  async function commit() {
    if (!onSave) return;
    if (draft === (empty ? "" : String(value))) { setEditing(false); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(draft.trim());
      setEditing(false);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); void commit(); }
    if (e.key === "Escape") { e.stopPropagation(); setEditing(false); setError(null); }
  };

  return (
    <div className="ds-field">
      <div className="ds-field-l">
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className="ds-field-v">
        {editing && editor ? (
          <>
            <div className="ds-field-edit">
              {editor.kind === "select" ? (
                <select ref={inputRef} className="ds-input" value={draft} disabled={saving}
                  onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} aria-label={label}>
                  {!editor.options.some((o) => o.value === draft) ? <option value={draft}>{draft || "—"}</option> : null}
                  {editor.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <>
                  <input ref={inputRef} className="ds-input" value={draft} disabled={saving} aria-label={label}
                    type={editor.kind === "number" ? "number" : editor.kind === "date" ? "date" : editor.kind === "email" ? "email" : "text"}
                    min={editor.kind === "number" ? editor.min : undefined}
                    maxLength={editor.kind === "text" ? editor.maxLength ?? 200 : undefined}
                    placeholder={editor.kind === "text" ? editor.placeholder : undefined}
                    list={editor.kind === "text" && editor.list?.length ? listId : undefined}
                    onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
                  {editor.kind === "text" && editor.list?.length ? (
                    <datalist id={listId}>{editor.list.map((o) => <option key={o} value={o} />)}</datalist>
                  ) : null}
                </>
              )}
              <button type="button" className="ds-btn primary sm" disabled={saving} onClick={() => void commit()}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" className="ds-btn ghost sm" disabled={saving} onClick={() => { setEditing(false); setError(null); }}>
                Cancel
              </button>
            </div>
            {error ? <div className="ds-field-err" role="alert">{error}</div> : null}
          </>
        ) : (
          <button type="button" className={`ds-value${editor && onSave ? "" : " readonly"}`}
            onClick={start} tabIndex={editor && onSave ? 0 : -1} aria-label={editor && onSave ? `Edit ${label}` : undefined}>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              {shown === null || shown === undefined ? <span className="empty">Not set</span> : shown}
            </span>
            {saved ? <span className="ds-field-ok">Saved</span> : editor && onSave ? <span className="pen" aria-hidden="true">Edit</span> : null}
          </button>
        )}
      </div>
    </div>
  );
}
