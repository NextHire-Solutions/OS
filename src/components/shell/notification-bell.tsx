"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
 * The bell (client feedback, 6 Oct): failed payments and portal blocks.
 * Admins, plus the people named for the lead cap's and new payments' alerts,
 * who see only those. For anyone else the API answers 403 and the bell is not
 * drawn. An alert about a client links to it; a payment alert to its Billing tab.
 */
type Item = { id: string; kind: string; severity: string; title: string; body: string | null; clientId?: string | null; createdAt: string; unread: boolean };

const openLink = (i: Item) => {
  if (!i.clientId) return null;
  const billing = i.kind.startsWith("stripe_");
  return { href: `/roster?client=${encodeURIComponent(i.clientId)}${billing ? "&tab=billing" : ""}`, label: billing ? "Open Billing" : "Open client" };
};

export function NotificationBell() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [capsOnly, setCapsOnly] = useState(false);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/workspace/notifications", { cache: "no-store" });
      if (r.status === 401 || r.status === 403) { setItems(null); return; }
      const b = await r.json();
      setItems(Array.isArray(b?.items) ? (b.items as Item[]) : []);
      setCapsOnly(b?.capsOnly === true);
    } catch { /* keep what we had */ }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 120_000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (items === null) return null;
  const unread = items.filter((i) => i.unread).length;
  const markAll = async () => {
    setItems((list) => (list ?? []).map((i) => ({ ...i, unread: false })));
    await fetch("/api/workspace/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  };
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div className="nb" ref={box}>
      <button type="button" className="nb-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
        {unread ? <span className="nb-count">{unread > 9 ? "9+" : unread}</span> : null}
      </button>
      {open ? (
        <div className="nb-panel" role="dialog" aria-label="Notifications">
          <div className="nb-head">
            <b>Notifications</b>
            {unread ? <button type="button" className="nb-link" onClick={() => void markAll()}>Mark all read</button> : null}
          </div>
          {items.length ? (
            <ul>
              {items.map((i) => {
                const link = openLink(i);
                return (
                  <li key={i.id} className={`nb-item sev-${i.severity}${i.unread ? " unread" : ""}`} data-kind={i.kind}>
                    <span className="nb-dot" aria-hidden="true" />
                    <span className="nb-text">
                      <b>{i.title}</b>
                      {i.body ? <span className="nb-body">{i.body}</span> : null}
                      <span className="nb-foot">
                        <small>{when(i.createdAt)}</small>
                        {link ? <a className="nb-open" href={link.href}>{link.label} →</a> : null}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="nb-empty">{capsOnly ? "Nothing yet. Lead cap and new payment alerts show here." : "Nothing yet. Failed payments, new payments and portal blocks show here."}</p>}
        </div>
      ) : null}
    </div>
  );
}
