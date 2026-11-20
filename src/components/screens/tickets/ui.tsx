"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { Person } from "@/lib/tools/tickets/types";

/* --------------------------------------------------------------------- icons --- */
const P: Record<string, React.ReactNode> = {
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  userx: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 11-7.4" /><path d="m17 17 4 4m0-4-4 4" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />,
  at: <><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  checkc: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  layers: <><path d="m12 2 10 5-10 5L2 7l10-5Z" /><path d="m2 17 10 5 10-5" /><path d="m2 12 10 5 10-5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  reply: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 6 6v5" /></>,
  ext: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  back: <path d="m15 18-6-6 6-6" />,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>,
  building: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>,
  note: <><path d="M4 4h16v12l-4 4H4z" /><path d="M16 20v-4h4" /></>,
  flag: <><path d="M4 22V4" /><path d="M4 4h12l-2 4 2 4H4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>,
  keyboard: <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
};

export function Icon({ name }: { name: keyof typeof P | string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{P[name] ?? null}</svg>;
}

/* ------------------------------------------------------------------- people --- */
export function firstName(name: string | null | undefined, email?: string | null): string {
  const n = (name ?? "").trim();
  if (n) return n.split(/\s+/)[0];
  return (email ?? "").split("@")[0] || "Someone";
}

export function initials(name: string | null | undefined, email?: string | null): string {
  const n = (name ?? "").trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }
  return (email ?? "?").slice(0, 2).toUpperCase();
}

const hue = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return (h + 200) % 360;
};

export function Avatar({ name, email, client, size, title }: { name?: string | null; email?: string | null; client?: boolean; size?: "lg"; title?: string }) {
  return (
    <span className={`tk-av${client ? " client" : ""}${size ? ` ${size}` : ""}`} style={client ? undefined : ({ "--h": hue(email ?? name ?? "") } as React.CSSProperties)} title={title ?? name ?? email ?? undefined}>
      {initials(name, email)}
    </span>
  );
}

export function usePeople(team: readonly Person[]) {
  return useMemo(() => {
    const m = new Map(team.map((p) => [p.email.toLowerCase(), p]));
    return {
      name: (email: string | null | undefined) => (email ? m.get(email.toLowerCase())?.name ?? email.split("@")[0] : ""),
      first: (email: string | null | undefined) => (email ? firstName(m.get(email.toLowerCase())?.name, email) : ""),
      has: (email: string) => m.has(email.toLowerCase()),
    };
  }, [team]);
}

/* --------------------------------------------------------------------- time --- */
const ET = "America/New_York";
export function fullTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
export function dayTime(iso: string, now: number): string {
  const d = new Date(iso);
  const sameDay = new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(d) === new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date(now));
  return new Intl.DateTimeFormat("en-US", sameDay ? { timeZone: ET, hour: "numeric", minute: "2-digit" } : { timeZone: ET, month: "short", day: "numeric" }).format(d);
}
export function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d ago` : fullTime(iso);
}

/** A clock for "3h" chips, ticking every 30 seconds. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/* ---------------------------------------------------------------------- api --- */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init?.json !== undefined ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/* ---------------------------------------------------------------- popovers --- */

/** Closes on Escape and on a click outside the wrapper. */
export function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey, true); };
  }, [open, close, ref]);
}

export interface PickOption { id: string; label: string; hint?: string; icon?: React.ReactNode; selected?: boolean }

/**
 * A searchable list under a button: arrows move, Enter picks, Escape closes. Used for the assignee, the client
 * and the snooze time.
 */
export function Picker({ open, onClose, options, onPick, placeholder, align, footer, empty, search = true, up }: {
  open: boolean; onClose: () => void; options: PickOption[]; onPick: (id: string) => void; placeholder?: string;
  align?: "right"; footer?: React.ReactNode; empty?: string; search?: boolean; up?: boolean;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(t)) : options;
  }, [q, options]);
  useEffect(() => { if (open) { setQ(""); setActive(0); } }, [open]);
  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, shown.length - 1))); }, [shown.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  if (!open) return null;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const o = shown[active]; if (o) { onPick(o.id); onClose(); } }
  };
  return (
    <div className={`tk-pop${align === "right" ? " right" : ""}${up ? " up" : ""}`} role="dialog" onKeyDown={onKey}>
      {search ? <input type="search" autoFocus placeholder={placeholder ?? "Search"} value={q} onChange={(e) => setQ(e.target.value)} aria-label={placeholder ?? "Search"} /> : <button type="button" autoFocus style={{ position: "absolute", opacity: 0, width: 1, height: 1 }} aria-hidden="true" tabIndex={-1} />}
      <div className="tk-opts" role="listbox" ref={listRef}>
        {shown.length ? shown.map((o, i) => (
          <button key={o.id} type="button" role="option" aria-selected={!!o.selected} data-i={i} data-active={i === active} className={`tk-opt${o.selected ? " sel" : ""}`}
            onMouseEnter={() => setActive(i)} onClick={() => { onPick(o.id); onClose(); }}>
            {o.icon}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</span>
            {o.hint && !o.selected ? <small>{o.hint}</small> : null}
          </button>
        )) : <div className="tk-pop-empty">{empty ?? "Nothing matches"}</div>}
      </div>
      {footer ? <div className="tk-pop-foot">{footer}</div> : null}
    </div>
  );
}

/*
 * "G then a letter" jumps to a view. The open ticket's own shortcuts (A assign, O open in Gmail, S snooze…) must
 * not also fire on that letter, so both listeners share when G was pressed. Cleared after the event, whichever
 * listener runs first.
 */
let gAt = 0;
export const markG = () => { gAt = Date.now(); };
export const inGSequence = () => Date.now() - gAt < 1200;
export const endG = () => { setTimeout(() => { gAt = 0; }, 0); };

/** Typing in a field, or a dialog open: shortcuts stand down. */
export function typingOrDialog(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return true;
  return !!document.querySelector("[data-modal-dialog], .tk-pop");
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
