"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { shortAge, waitTone } from "@/lib/tools/tickets/ticket-rules";
import type { TicketList, TicketListItem } from "@/lib/tools/tickets/types";
import { isView, VIEW_HINT, VIEW_LABEL, VIEWS, type View } from "@/lib/tools/tickets/views";

import { TicketPane } from "./ticket-pane";
import { api, Avatar, endG, Icon, inGSequence, markG, typingOrDialog, useNow, usePeople } from "./ui";

/*
 * TICKETS — every email a client sends to a connected teammate's Gmail, as one shared, tracked list
 * (the user, 20 Nov). Views on the left, the list in the middle (longest-waiting first), the conversation on the
 * right. Live: the list refreshes every 20 seconds while the tab is visible. Gmail-style keys: J/K move, Enter
 * opens, / searches, G then O·M·U·W·D·A jumps to a view, ? lists them all.
 */

const VIEW_ICON: Record<View, string> = { open: "inbox", mine: "user", unassigned: "userx", waiting: "clock", snoozed: "moon", mentions: "at", done: "checkc", all: "layers", others: "mail" };
const EMPTY: Record<View, { title: string; body: string }> = {
  open: { title: "No client is waiting on you", body: "Every conversation has an answer. New client emails land here the minute they arrive." },
  mine: { title: "Nothing assigned to you", body: "Press Q on any ticket to take it, or pick one from Unassigned." },
  unassigned: { title: "Everything has an owner", body: "New client emails show up here until someone takes them." },
  waiting: { title: "Nobody to wait on", body: "When the team replies in Gmail, the ticket moves here until the client writes back." },
  snoozed: { title: "Nothing snoozed", body: "Snooze a ticket (S) to hide it until a time you choose. It comes back to Open by itself." },
  mentions: { title: "No mentions yet", body: "When a teammate @mentions you in a note, the ticket shows up here." },
  done: { title: "Nothing finished yet", body: "Tickets you mark Done (E) collect here. A client's new email reopens them." },
  all: { title: "No tickets yet", body: "Client emails appear here once a teammate's inbox is connected." },
  others: { title: "No other email yet", body: "Email to a connected inbox from anyone who isn't a client lands here. Open one and move it to a client when it belongs to one." },
};
const GO: Record<string, View> = { o: "open", m: "mine", u: "unassigned", w: "waiting", s: "snoozed", d: "done", a: "all", n: "mentions" };

function readUrl(): { view: View; t: number | null; q: string; client: string; mailbox: string } {
  if (typeof window === "undefined") return { view: "open", t: null, q: "", client: "", mailbox: "" };
  const p = new URLSearchParams(window.location.search);
  const t = Number(p.get("t"));
  return { view: isView(p.get("view")) ? (p.get("view") as View) : "open", t: Number.isInteger(t) && t > 0 ? t : null, q: p.get("q") ?? "", client: p.get("client") ?? "", mailbox: p.get("inbox") ?? "" };
}

export function TicketsScreen() {
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("open");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [client, setClient] = useState("");
  const [mailbox, setMailbox] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [data, setData] = useState<TicketList | null>(null);
  const [rows, setRows] = useState<TicketListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const req = useRef(0);
  const rowsCount = useRef(0);
  const now = useNow();
  const people = usePeople(data?.team ?? []);

  // Start from the address (a pasted link opens the same view and ticket).
  useEffect(() => {
    const u = readUrl();
    setView(u.view); setQ(u.q); setDebounced(u.q); setClient(u.client); setMailbox(u.mailbox); setSelected(u.t);
    setReady(true);
    const onPop = () => { const v = readUrl(); setView(v.view); setSelected(v.t); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  // Keep the address in step, without a navigation.
  useEffect(() => {
    if (!ready) return;
    const p = new URLSearchParams();
    if (view !== "open") p.set("view", view);
    if (selected) p.set("t", String(selected));
    if (debounced) p.set("q", debounced);
    if (client) p.set("client", client);
    if (mailbox) p.set("inbox", mailbox);
    const next = `${window.location.pathname}${p.size ? `?${p}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", next);
  }, [ready, view, selected, debounced, client, mailbox]);

  const load = useCallback(async (quiet = false) => {
    const n = ++req.current;
    if (!quiet) setLoading(true);
    try {
      // A refresh keeps every row already shown ("Show more" included); a new view starts at one page.
      const p = new URLSearchParams({ view, limit: String(quiet ? Math.min(500, Math.max(100, rowsCount.current)) : 100) });
      if (debounced) p.set("q", debounced);
      if (client) p.set("client", client);
      if (mailbox) p.set("mailbox", mailbox);
      const d = await api<TicketList>(`/api/tools/tickets?${p}`);
      if (n !== req.current) return;
      setData(d);
      setRows(d.rows);
      setError(null);
      setStale(false);
    } catch (e) {
      if (n !== req.current) return;
      if (quiet) setStale(true);
      else setError(e instanceof Error ? e.message : "Couldn't load tickets");
    } finally {
      if (n === req.current) setLoading(false);
    }
  }, [view, debounced, client, mailbox]);

  useEffect(() => { if (ready) void load(); }, [ready, load]);
  useEffect(() => { rowsCount.current = rows.length; }, [rows]);

  // Live: every 20 seconds while visible, and at once on coming back to the tab.
  useEffect(() => {
    if (!ready) return;
    const tick = () => { if (document.visibilityState === "visible") void load(true); };
    const t = setInterval(tick, 20_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [ready, load]);

  const loadMore = async () => {
    if (!data) return;
    const n = req.current;
    const p = new URLSearchParams({ view, offset: String(rows.length) });
    if (debounced) p.set("q", debounced);
    if (client) p.set("client", client);
    if (mailbox) p.set("mailbox", mailbox);
    try {
      const d = await api<TicketList>(`/api/tools/tickets?${p}`);
      if (n !== req.current) return; // the view changed meanwhile: these rows belong to another list
      setRows((cur) => [...cur, ...d.rows.filter((r) => !cur.some((c) => c.id === r.id))]);
    } catch { /* the button stays */ }
  };

  const open = useCallback((n: number | null) => {
    setSelected(n);
    if (n) setRows((cur) => cur.map((r) => (r.number === n ? { ...r, unread: false } : r)));
  }, []);

  const move = useCallback((dir: 1 | -1) => {
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.number === selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + dir))];
    open(next.number);
    requestAnimationFrame(() => rowsRef.current?.querySelector<HTMLElement>(`[data-n="${next.number}"]`)?.scrollIntoView({ block: "nearest" }));
  }, [rows, selected, open]);

  // List-level keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && document.activeElement === searchRef.current) { searchRef.current?.blur(); return; }
      if (typingOrDialog(e)) return;
      const k = e.key;
      if (inGSequence() && k !== "g") { endG(); if (GO[k.toLowerCase()]) { e.preventDefault(); setView(GO[k.toLowerCase()]); } return; }
      if (k === "g") { markG(); return; }
      if (k === "j" || k === "ArrowDown") { e.preventDefault(); move(1); }
      else if (k === "k" || k === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (k === "/") { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
      else if (k === "?") { e.preventDefault(); setKeysOpen(true); }
      else if (k === "Escape" && selected) { e.preventDefault(); open(null); }
      else if (k === "Enter" && !selected && rows[0] && !(e.target as HTMLElement | null)?.closest?.("button, a, select, [role=button]")) { e.preventDefault(); open(rows[0].number); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, selected, rows, open]);

  // Stable for the open ticket: a new search or view must not reset it (and lose a half-written note).
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  const onChanged = useCallback(() => { void loadRef.current(true); }, []);
  const counts = data?.counts ?? {};
  const connected = (data?.mailboxes ?? []).filter((m) => m.state !== "paused");
  const coverageTeam = (data?.team ?? []);
  const coverage = coverageTeam.filter((p) => connected.some((m) => m.email.toLowerCase() === p.email)).length;
  const clientName = data?.clients.find((c) => c.id === client)?.name;
  const filtersOn = !!(client || mailbox || debounced);

  if (data && !data.ready) {
    return (
      <div className="tk-shell"><div className="tk-page"><div className="tk-empty">
        <div className="tk-empty-art"><Icon name="flag" /></div>
        <h3>Tickets is almost ready</h3>
        <p>{data.admin ? data.setup : "An admin needs to finish one setup step. Check back soon."}</p>
      </div></div></div>
    );
  }

  return (
    <div className="tk-app" data-reading={selected ? "true" : "false"}>
      <nav className="tk-nav" aria-label="Ticket views">
        <div>
          <div className="tk-nav-h">Tickets</div>
          <div className="tk-views">
            {VIEWS.map((v) => {
              const n = counts[v];
              const hot = v === "open" || v === "unassigned" || v === "mine";
              return (
                <Fragment key={v}>
                {v === "others" ? <div className="tk-views-sep" role="separator" aria-hidden="true" /> : null}
                <button type="button" className="tk-view" aria-current={view === v} title={VIEW_HINT[v]} onClick={() => { setView(v); }}>
                  <Icon name={VIEW_ICON[v]} />
                  <span>{VIEW_LABEL[v]}</span>
                  {v === "mentions" && data?.unread.mentions ? <span className="tk-view-dot" aria-label={`${data.unread.mentions} unread`} /> : null}
                  {n !== undefined && n > 0 ? <span className={`tk-view-n${hot && n ? " hot" : ""}`}>{n}</span> : null}
                </button>
                </Fragment>
              );
            })}
          </div>
        </div>
        <div className="tk-filter">
          <label htmlFor="tk-f-client">Client</label>
          <select id="tk-f-client" className="tk-select" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">All clients</option>
            {(data?.clients ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === "churned" ? " (churned)" : ""}</option>)}
          </select>
          <label htmlFor="tk-f-inbox" style={{ marginTop: 6 }}>Received by</label>
          <select id="tk-f-inbox" className="tk-select" value={mailbox} onChange={(e) => setMailbox(e.target.value)}>
            <option value="">Any inbox</option>
            {(data?.mailboxes ?? []).map((m) => <option key={m.email} value={m.email}>{people.has(m.email) ? people.name(m.email) : m.name ?? m.email}</option>)}
          </select>
        </div>
        <div className="tk-nav-foot">
          <div className="tk-cov"><Icon name="mail" />{coverage} of {coverageTeam.length || "–"} inboxes connected</div>
          <div className="tk-cov-bar"><span style={{ width: `${coverageTeam.length ? (100 * coverage) / coverageTeam.length : 0}%` }} /></div>
          {data?.myMailbox?.state === "reconnect"
            ? <><b style={{ color: "var(--ds-red)" }}>Your Gmail needs reconnecting.</b> <a href="/tickets/inboxes">Reconnect</a></>
            : data?.myMailbox ? <>Client email to you is shared here. <a href="/tickets/inboxes">Manage</a></>
            : <>Your inbox isn&apos;t connected, so client email to you won&apos;t show. <a href="/tickets/inboxes">Connect it</a></>}
        </div>
      </nav>

      <section className="tk-list" aria-label="Tickets">
        <div className="tk-list-head">
          <div className="tk-list-title">
            <h2>{VIEW_LABEL[view]}</h2>
            {data ? <span>{data.total}</span> : null}
            <span className={`tk-live${stale ? " stale" : ""}`} title={stale ? "Couldn't refresh. Retrying." : "Updates every 20 seconds"}><i />{stale ? "Offline" : "Live"}</span>
          </div>
          <div className="tk-viewsel">
            <select className="tk-select" aria-label="View" value={view} onChange={(e) => setView(e.target.value as View)}>
              {VIEWS.map((v) => <option key={v} value={v}>{VIEW_LABEL[v]}{counts[v] ? ` (${counts[v]})` : ""}</option>)}
            </select>
            <select className="tk-select" aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">All clients</option>
              {(data?.clients ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <label className="tk-search">
            <Icon name="search" />
            <input ref={searchRef} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search subject, client, person, #number" aria-label="Search tickets" />
            {!q ? <kbd>/</kbd> : null}
          </label>
          {filtersOn ? (
            <div className="tk-chips">
              {clientName ? <span className="tk-chip-f">{clientName}<button type="button" aria-label="Clear client" onClick={() => setClient("")}><Icon name="x" /></button></span> : null}
              {mailbox ? <span className="tk-chip-f">Received by {people.first(mailbox) || mailbox}<button type="button" aria-label="Clear inbox" onClick={() => setMailbox("")}><Icon name="x" /></button></span> : null}
              {debounced ? <span className="tk-chip-f">“{debounced}”<button type="button" aria-label="Clear search" onClick={() => setQ("")}><Icon name="x" /></button></span> : null}
            </div>
          ) : null}
        </div>

        <div className="tk-rows" ref={rowsRef}>
          {loading && !rows.length ? Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="tk-skel" aria-hidden="true"><i style={{ width: "55%" }} /><i style={{ width: "85%" }} /><i style={{ width: "70%" }} /></div>
          )) : error ? (
            <div className="tk-empty"><div className="tk-empty-art"><Icon name="refresh" /></div><h3>Couldn&apos;t load tickets</h3><p>{error}</p><button type="button" className="tk-btn" onClick={() => void load()}>Try again</button></div>
          ) : !rows.length ? (
            !connected.length && view !== "done" ? (
              <div className="tk-empty">
                <div className="tk-empty-art"><Icon name="mail" /></div>
                <h3>Connect an inbox to start</h3>
                <p>Tickets shows email that clients send to the team. Connect your Gmail and every client email to you appears here for the whole team. Nothing else in your inbox is read into the OS.</p>
                <a className="tk-btn pri" href="/tickets/inboxes">Connect your Gmail</a>
              </div>
            ) : filtersOn ? (
              <div className="tk-empty"><div className="tk-empty-art"><Icon name="search" /></div><h3>No tickets match</h3><p>Nothing in {VIEW_LABEL[view]} matches these filters. Try All, or clear a filter.</p><button type="button" className="tk-btn" onClick={() => { setQ(""); setClient(""); setMailbox(""); }}>Clear filters</button></div>
            ) : (
              <div className="tk-empty"><div className={`tk-empty-art${view === "open" ? " ok" : ""}`}><Icon name={view === "open" ? "checkc" : VIEW_ICON[view]} /></div><h3>{EMPTY[view].title}</h3><p>{EMPTY[view].body}</p></div>
            )
          ) : (
            <>
              {rows.map((r) => <Row key={r.id} r={r} active={r.number === selected} onOpen={() => open(r.number)} now={now} me={data?.me ?? ""} people={people} viewers={data?.viewers[r.id] ?? []} view={view} />)}
              {data && rows.length < data.total ? <button type="button" className="tk-btn tk-more" onClick={() => void loadMore()}>Show more ({data.total - rows.length} left)</button> : null}
            </>
          )}
        </div>
      </section>

      {selected && data ? (
        <TicketPane key={selected} number={selected} team={data.team} clients={data.clients} me={data.me} onChanged={onChanged}
          onBack={() => open(null)} onRemoved={() => { open(null); void load(true); }} />
      ) : (
        <div className="tk-read">
          <div className="tk-empty">
            <div className="tk-empty-art"><Icon name="inbox" /></div>
            <h3>Pick a ticket</h3>
            <p>Client emails to the team, in one place. Assign one to yourself with Q, mark it Done with E, or press ? for every shortcut.</p>
            <button type="button" className="tk-btn" onClick={() => setKeysOpen(true)}><Icon name="keyboard" />Keyboard shortcuts</button>
          </div>
        </div>
      )}

      <ModalDialog open={keysOpen} onClose={() => setKeysOpen(false)} width={560} label="Keyboard shortcuts">
        <div className="tk-dialog">
          <h3>Keyboard shortcuts</h3>
          <div className="tk-keys">
            {[
              ["Next / previous ticket", ["J", "K"]], ["Close the ticket", ["Esc"]], ["Search", ["/"]], ["Mark Done (again: reopen)", ["E"]],
              ["Assign to me", ["Q"]], ["Assign to…", ["A"]], ["Snooze", ["S"]], ["Add a note", ["N"]], ["Save the note", ["⌘", "↵"]],
              ["Not a ticket", ["I"]], ["Reply in Gmail", ["O"]], ["Go to Open", ["G", "O"]], ["Go to Mine", ["G", "M"]],
              ["Go to Unassigned", ["G", "U"]], ["Go to Waiting", ["G", "W"]], ["Go to Done", ["G", "D"]], ["This list", ["?"]],
            ].map(([label, keys]) => (
              <div key={label as string}><span>{label}</span><span>{(keys as string[]).map((k) => <kbd key={k} className="tk-kbd">{k}</kbd>)}</span></div>
            ))}
          </div>
          <div className="tk-dialog-f"><button type="button" className="tk-btn" onClick={() => setKeysOpen(false)}>Close</button></div>
        </div>
      </ModalDialog>
    </div>
  );
}

function Row({ r, active, onOpen, now, me, people, viewers, view }: {
  r: TicketListItem; active: boolean; onOpen: () => void; now: number; me: string; people: ReturnType<typeof usePeople>; viewers: string[]; view: View;
}) {
  const snoozed = r.snoozedUntil && Date.parse(r.snoozedUntil) > now;
  const tone = r.status === "open" ? waitTone(r.waitingSince, now) : null;
  const age = r.status === "open" && r.waitingSince ? shortAge(r.waitingSince, now) : shortAge(r.lastActivityAt, now);
  const who = r.contact.name ?? r.contact.email ?? "Unknown sender";
  return (
    <button type="button" className="tk-row" data-n={r.number} aria-current={active} data-unread={r.unread} onClick={onOpen}>
      {r.unread ? <span className="tk-udot" aria-label="New activity" /> : null}
      <span className="tk-row-top">
        <span className="tk-who">{who}</span>
        {r.client ? <span className="tk-client" title={r.client.name}><i className={r.client.status === "churned" ? "churned" : r.client.status === "paused" ? "paused" : ""} /><span className="tk-client-n">{r.client.name}</span></span> : <span className="tk-client tk-client-other" title="Not from a client's address"><span className="tk-client-n">Others</span></span>}
        <span className={`tk-age${tone ? ` ${tone === "fresh" ? "" : tone}` : " plain"}`} title={r.status === "open" && r.waitingSince ? `Waiting since ${new Date(r.waitingSince).toLocaleString()}` : "Last activity"}>{age}</span>
      </span>
      <span className="tk-subj">{r.subject}</span>
      {r.snippet ? <span className="tk-snip">{r.snippet}</span> : null}
      <span className="tk-row-meta">
        {snoozed ? <span className="tk-pill snoozed">Snoozed</span>
          : r.status !== "open" || view === "all" || view === "mine" ? <span className={`tk-pill ${r.status}`}>{r.status === "ignored" ? "Not a ticket" : r.status === "waiting" ? "Waiting" : r.status === "done" ? "Done" : "Open"}</span>
          : r.needsFirstResponse ? <span className="tk-pill first">New</span> : null}
        {r.lastFrom === "team" && r.status === "open" ? <span className="tk-pill view" title="The team replied last"><Icon name="reply" /></span> : null}
        {viewers.length ? <span className="tk-pill view" title={`${viewers.map((v) => people.first(v)).join(", ")} viewing`}><Icon name="eye" />{people.first(viewers[0])}</span> : null}
        <span className="tk-sp" />
        {r.messageCount > 1 ? <span className="tk-recv" title={`${r.messageCount} emails in this conversation`}><Icon name="mail" />{r.messageCount}</span> : null}
        {r.assignee ? <Avatar email={r.assignee} name={people.name(r.assignee)} title={r.assignee === me ? "Assigned to you" : `Assigned to ${people.name(r.assignee)}`} />
          : <span className="tk-av none" title="Unassigned" aria-label="Unassigned"><Icon name="user" /></span>}
      </span>
    </button>
  );
}
