"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { CommissionRow, CommissionsView, RepSummary } from "@/lib/commissions/load";
import { planLabel } from "@/components/clients/cells";

import { PlaceholderScreen } from "./lazy";

/*
 * COMMISSIONS — sales payouts, to each client's salesperson and account manager.
 *
 * Built from the client's mockup (commissions-mockup.html): the next payout
 * run, the account manager's card with what is due, their clients, an admin
 * section. (The rules section was removed on 1 Oct, Eddy.) What changed from the mockup, and why:
 *
 *   - "Sales rep" is the client's Account Manager — a Team access member —
 *     read from the master record, so assigning here and on Clients is the
 *     same edit (one editor per field, §7).
 *   - "Assign new client" assigns an EXISTING client: clients are created
 *     once, on the Clients page (§2/§13).
 *   - Amounts are what actually came in — paid Stripe invoices — because
 *     BrokerStaffer bills every 14 or 28 days, not monthly. A client with no
 *     Stripe link can be given a gross by an admin; its payments are then
 *     estimated on its billing schedule and marked "Estimate".
 *
 * Scope is enforced by the server: an account manager's response contains
 * only their own clients. The "viewing as" switch exists for admins only.
 */

const money = (n: number | null | undefined, cents = false) =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
const pct = (r: number) => `${Math.round(r * 100)}%`;
const ROLE: Record<"salesperson" | "account_manager", string> = { salesperson: "Salesperson", account_manager: "Account manager" };
const day = (iso: string, year = false) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });

export function CommissionsScreen() {
  const [as, setAs] = useState<string>("all");
  const [run, setRun] = useState<string | null>(null);
  const [data, setData] = useState<CommissionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (a: string, r: string | null) => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (a) q.set("as", a);
      if (r) q.set("run", r);
      const res = await fetch(`/api/workspace/commissions?${q}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setData(body as CommissionsView);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load commissions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(as, run); }, [as, run, load]);

  if (!data) {
    return error
      ? <div className="cx-page"><p className="ds-note"><b>Commissions could not be loaded.</b> {error}</p></div>
      : <PlaceholderScreen cards={3} />;
  }
  return (
    <CommissionsView data={data} busy={loading} error={error}
      onAs={(a) => setAs(a)} onRun={(r) => setRun(r)} onChanged={() => void load(as, run)} />
  );
}

function CommissionsView({ data, busy, error, onAs, onRun, onChanged }: {
  data: CommissionsView; busy: boolean; error: string | null;
  onAs: (a: string) => void; onRun: (r: string) => void; onChanged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const single = data.scope !== "all";
  const shown = single ? data.reps[0] ?? null : null;
  const total = useMemo(() => data.rows.reduce((t, r) => t + r.due, 0), [data.rows]);
  // Every column sorts (Eddy, 1 Oct). Starts on what is due, largest first — the server's order.
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "due", dir: -1 });
  const onSort = (k: SortKey) => setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : NUMERIC.has(k) ? -1 : 1 }));
  const rows = useMemo(() => sortRows(data.rows, sort.k, sort.dir), [data.rows, sort]);

  return (
    <div className="cx-page" aria-busy={busy}>
      {/* ---------------------------------------------------------- header */}
      <header className="cm-head">
        <div className="cx-head-t">
          <span className="cx-kicker">Workspace</span>
          <h1>Commissions</h1>
          <p>Sales payouts on active clients — the salesperson earns 20% or 10% of each payment after Stripe&rsquo;s fee, and the account manager 5% from the client&rsquo;s second month. Payouts run on the 1st and 15th.</p>
        </div>
        <div className="cm-run">
          <span className="cx-kicker">{data.runOpen ? "Next payout run" : "Payout run"}</span>
          <span className="cm-run-nav">
            <button type="button" className="rx-icon" onClick={() => onRun(data.previousRun)} aria-label={`Previous run, ${day(data.previousRun)}`} title={`Previous run · ${day(data.previousRun)}`}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
            </button>
            <b>{day(data.run, true)}</b>
            <button type="button" className="rx-icon" onClick={() => onRun(data.nextRun)} aria-label={`Next run, ${day(data.nextRun)}`} title={`Next run · ${day(data.nextRun)}`}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            </button>
          </span>
          <small>{data.runOpen ? `billed so far · as of ${day(data.today)}` : "closed"}</small>
        </div>
      </header>

      {/* ------------------------------------------------------ viewing as */}
      <div className="cm-viewing">
        {data.viewer.admin ? (
          <>
            <span>Viewing</span>
            <select className="cm-select" value={data.scope} onChange={(e) => onAs(e.target.value)} aria-label="Person to view">
              <option value="all">Everyone</option>
              {data.people.map((p) => <option key={p.key} value={p.key}>{p.name} — {p.roles.map((r) => ROLE[r]).join(" & ")}</option>)}
            </select>
            <span className="cm-note">— each person sees only their own clients and payouts. You are an admin, so you can see everyone.</span>
          </>
        ) : (
          <span>Signed in as <b>{data.viewer.name}</b><span className="cm-note"> — you see only your own clients and payouts.</span></span>
        )}
      </div>

      {data.viewer.admin && !data.settingsAvailable ? (
        <p className="ds-note" style={{ margin: 0 }}>
          <b>Rates and manual gross amounts can&rsquo;t be saved yet.</b> Run <code>migrations/0019_commissions.sql</code> in Supabase once.
          Until then only clients linked to Stripe are counted.
        </p>
      ) : null}
      {error ? <p className="ds-note" style={{ margin: 0 }}><b>Could not refresh.</b> {error}</p> : null}
      {data.unavailable.length ? <p className="ds-note" style={{ margin: 0 }}>Not read this time: {data.unavailable.join(", ")}.</p> : null}

      {/* ------------------------------------------------------- rep cards */}
      <section className="cm-reps" aria-label="Due per person">
        {(single && shown ? [shown] : data.reps).map((r) => (
          <RepCard key={r.key} rep={r} run={data.run} admin={data.viewer.admin} canSave={data.settingsAvailable}
            onPick={single || !data.viewer.admin ? undefined : () => onAs(r.key)} onChanged={onChanged} />
        ))}
        {data.reps.length === 0 ? (
          <p className="cm-empty">{data.viewer.admin
            ? "Nobody holds a client yet — give people the Salesperson or Account manager role on Team access, then assign clients below."
            : "You have no clients yet. Your clients and payouts appear here once one is assigned to you."}</p>
        ) : null}
      </section>

      {/* ----------------------------------------------------------- table */}
      <section className="cx-panel">
        <div className="cx-toolbar">
          <span className="cm-title">{!data.viewer.admin ? "My clients" : single ? `${shown?.name ?? ""}’s clients` : "Clients"}</span>
          <span className="cx-toolbar-r">
            <span className="cx-count">{data.rows.length} <em>clients</em></span>
            <span className="cm-total">Due {day(data.run)} <b>{money(total, true)}</b></span>
          </span>
        </div>
        <div className="cx-scroll" style={{ maxHeight: "none", minHeight: 0 }}>
          <table className="cx-table cm-table">
            <thead>
              <tr className="cx-cols">
                {COLUMNS.map(([k, h], i) => {
                  const on = sort.k === k;
                  return (
                    <th key={k} className={i === 0 ? "cx-pin" : NUMERIC.has(k) ? "num" : undefined}
                      aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                      title={k === "net" ? "Monthly gross less Stripe's fee: 2.9% + $0.30 per successful card charge. Commission is paid on this." : undefined}>
                      <button type="button" onClick={() => onSort(k)}>
                        {k === "due" ? `Due ${day(data.run)}` : h}
                        <span className={`cx-arrow${on ? " on" : ""}`} aria-hidden="true">{on ? (sort.dir === 1 ? "↑" : "↓") : "↕"}</span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr><td colSpan={8} className="cx-empty">{single ? "No active clients are assigned to this person." : "No active client has a salesperson or account manager yet."}</td></tr>
              ) : rows.map((r) => (
                <Row key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------------------------------------------------------- admin */}
      {data.viewer.admin ? <Assign data={data} onChanged={onChanged} /> : null}

      <footer className="cm-foot">
        Active clients only · payouts run on the 1st and 15th of each month · amounts are paid Stripe invoices on the client&rsquo;s subscription,
        less Stripe&rsquo;s fee (2.9% + $0.30 per charge) · a client not linked to Stripe uses a gross an admin entered, estimated on its billing schedule and marked Estimate.
      </footer>
    </div>
  );
}

type SortKey = "name" | "plan" | "gross" | "net" | "salesperson" | "accountManager" | "status" | "due";
const COLUMNS: [SortKey, string][] = [
  ["name", "Client"], ["plan", "Plan"], ["gross", "Monthly (gross)"], ["net", "Monthly (net)"],
  ["salesperson", "Salesperson"], ["accountManager", "Account manager"], ["status", "Status"], ["due", "Due"],
];
const NUMERIC = new Set<SortKey>(["gross", "net", "due"]);
const PLAN_ORDER: Record<string, number> = { minimum: 1, production: 2, partner: 3 };

/** Sorted by one column; empty values always last, ties by client name. */
function sortRows(rows: CommissionRow[], k: SortKey, dir: 1 | -1): CommissionRow[] {
  const val = (r: CommissionRow): string | number | null => {
    switch (k) {
      case "name": return r.name.toLowerCase();
      case "plan": return r.plan ? PLAN_ORDER[r.plan] ?? 9 : null;
      case "gross": return r.gross;
      case "net": return r.net;
      case "salesperson": return r.salesperson?.toLowerCase() || null;
      case "accountManager": return r.accountManager?.toLowerCase() || null;
      case "status": return r.statusLabel.toLowerCase();
      case "due": return r.due;
    }
  };
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === null && y === null) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return c ? c * dir : a.name.localeCompare(b.name);
  });
}

function RepCard({ rep, run, admin, canSave, onPick, onChanged }: {
  rep: RepSummary; run: string; admin: boolean; canSave: boolean; onPick?: () => void; onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function setRate(key: string, v: number) {
    setSaving(true); setErr(null);
    try {
      const res = await fetch("/api/workspace/commissions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "rates", key, rate: v }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); } finally { setSaving(false); }
  }
  const both = rep.roles.length > 1;
  return (
    <div className="cm-rep">
      <div className="cm-rep-top">
        <span>
          {onPick ? <button type="button" className="cm-rep-name link" onClick={onPick}>{rep.name}</button> : <span className="cm-rep-name">{rep.name}</span>}
          <small className="cm-note" style={{ display: "block" }}>{rep.roles.map((r) => ROLE[r.role]).join(" & ")}</small>
        </span>
        <span className="cm-rate" style={{ display: "grid", justifyItems: "end", gap: 2 }}>
          {rep.roles.map((r) => (
            <span key={r.key}>
              {r.role === "salesperson" && admin && canSave ? (
                <select className="cm-rate-sel" value={r.rate} disabled={saving} aria-label={`${rep.name}'s salesperson rate`}
                  onChange={(e) => void setRate(r.key, Number(e.target.value))}>
                  <option value={0.2}>20%</option>
                  <option value={0.1}>10%</option>
                </select>
              ) : pct(r.rate)}{" "}{both ? (r.role === "salesperson" ? "AS SALESPERSON" : "AS ACCOUNT MANAGER · MONTH 2+") : r.role === "account_manager" ? "OF NET · MONTH 2+" : "OF NET"}
            </span>
          ))}
        </span>
      </div>
      <div className="cm-due">
        <div>
          <span className="k">Due {day(run)}</span>
          <small>
            {rep.clients} client{rep.clients === 1 ? "" : "s"}
            {both ? ` · ${rep.roles.map((r) => `${ROLE[r.role].toLowerCase()} ${money(r.due, true)}`).join(" + ")}` : ""}
          </small>
        </div>
        <b>{money(rep.due, true)}</b>
      </div>
      {err ? <div className="ds-field-err" role="alert">{err}</div> : null}
    </div>
  );
}

function Row({ r, open, onToggle }: { r: CommissionRow; open: boolean; onToggle: () => void }) {
  const tone = r.status === "churned" ? "cancelled" : r.statusLabel === "Month 1" ? "month1" : r.status === "paused" ? "paused" : "active";
  return (
    <>
      <tr onClick={onToggle} className={open ? "on" : undefined} aria-expanded={open}>
        <td className="cx-pin"><b className="cx-strong">{r.name}</b></td>
        <td>{r.plan ? <span className={`cx-plan p-${r.plan}`}>{planLabel(r.plan)}</span> : <span className="cx-none">—</span>}</td>
        <td className="num">
          {money(r.gross)}
          {r.grossSource ? <span className={`cm-src ${r.grossSource}`}>{r.grossSource === "stripe" ? "Stripe" : "Estimate"}</span>
            : <span className="cm-src none" title="Not linked to Stripe and no gross set">not set</span>}
        </td>
        <td className="num">{money(r.net)}</td>
        <td>{r.salesperson ?? <span className="cx-none">—</span>}</td>
        <td>{r.accountManager ?? <span className="cx-none">—</span>}</td>
        <td><span className={`cm-status ${tone}`}>{r.statusLabel}</span></td>
        <td className="num"><b className={r.due ? "cx-strong" : "cx-none"}>{money(r.due, true)}</b></td>
      </tr>
      {open ? (
        <tr className="cm-lines cx-static">
          <td colSpan={8}>
            {r.earnings.map((e) => (
              <div key={e.key} style={{ marginBottom: 10 }}>
                <span className="cm-note"><b>{e.name}</b> · {ROLE[e.role]} · {pct(e.rate)} of each payment after Stripe&rsquo;s fee{e.role === "account_manager" ? ", from Month 2" : ""}</span>
                {e.lines.length ? (
                  <table>
                    <thead><tr><th>Billed</th><th>Payment</th><th>Stripe fee</th><th>Net</th><th>Source</th><th className="num">Rate</th><th className="num">Commission</th></tr></thead>
                    <tbody>
                      {e.lines.map((l, i) => (
                        <tr key={i}>
                          <td>{day(l.date, true)}</td><td>{money(l.amount, true)}</td><td>−{money(l.fee, true)}</td><td>{money(l.net, true)}</td>
                          <td>{l.source === "stripe" ? "Stripe · paid" : "Estimate"}</td><td className="num">{pct(l.rate)}</td><td className="num">{money(l.commission, true)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <span className="cm-note" style={{ display: "block" }}>{e.role === "account_manager" && r.statusLabel === "Month 1" ? "Month 1 — the account manager earns from Month 2." : "No payment falls on this run."}</span>}
                <span className="cm-note">Earned to date on this client: <b>{money(e.lifetime, true)}</b></span>
              </div>
            ))}
            <span className="cm-note">{r.lastPayment ? `Last payment ${day(r.lastPayment, true)}` : "No payment yet"}{!r.stripeLinked ? " · not linked to Stripe" : ""}</span>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* Admin: give a client its salesperson and account manager (and, if it has no Stripe link, a gross). */
function Assign({ data, onChanged }: { data: CommissionsView; onChanged: () => void }) {
  const [clientId, setClientId] = useState("");
  const [sp, setSp] = useState("");
  const [am, setAm] = useState("");
  const [gross, setGross] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  // A client missing a role is listed from `unassigned` and, when an admin is
  // viewing one person, may have no row here. Its current salesperson,
  // manager and gross come from the unassigned entry instead — otherwise
  // they read as empty and Assign saved "none" over them.
  const row = data.rows.find((r) => r.id === clientId) ?? data.unassigned.find((u) => u.id === clientId);
  const choices = [
    ...data.unassigned.filter((u) => !data.rows.some((r) => r.id === u.id))
      .map((c) => ({ id: c.id, name: c.name, note: `no ${c.missing.map((m) => ROLE[m].toLowerCase()).join(" or ")}` })),
    ...data.rows.map((r) => ({ id: r.id, name: r.name, note: [r.salesperson, r.accountManager].filter(Boolean).join(" · ") })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  useEffect(() => {
    setSp(row?.salesperson ?? "");
    setAm(row?.accountManager ?? "");
    setGross(row?.manualGross != null ? String(row.manualGross) : "");
  }, [clientId, row?.salesperson, row?.accountManager, row?.manualGross]);

  async function submit() {
    if (!clientId) return;
    setSaving(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { kind: "assign", clientId, salesperson: sp, accountManager: am };
      if (data.settingsAvailable) body.monthlyGross = gross.trim() === "" ? null : Number(gross);
      const res = await fetch("/api/workspace/commissions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => null);
      if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
      setMsg({ text: `Saved — ${choices.find((c) => c.id === clientId)?.name ?? "client"}: salesperson ${sp || "none"}, account manager ${am || "none"}.` });
      onChanged();
    } catch (e) { setMsg({ text: e instanceof Error ? e.message : "Could not save", bad: true }); } finally { setSaving(false); }
  }

  return (
    <section>
      <div className="cm-h2">Assign a client <span className="cm-admin">Admin only</span></div>
      <div className="cm-assign">
        <select className="cm-select" value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client">
          <option value="">Choose a client…</option>
          {choices.map((c) => <option key={c.id} value={c.id}>{c.name}{c.note ? ` — ${c.note}` : ""}</option>)}
        </select>
        <select className="cm-select" value={sp} onChange={(e) => setSp(e.target.value)} aria-label="Salesperson" disabled={!clientId}>
          <option value="">No salesperson</option>
          {sp && !data.salespeople.includes(sp) ? <option value={sp}>{sp}</option> : null}
          {data.salespeople.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <select className="cm-select" value={am} onChange={(e) => setAm(e.target.value)} aria-label="Account manager" disabled={!clientId}>
          <option value="">No account manager</option>
          {am && !data.team.includes(am) ? <option value={am}>{am}</option> : null}
          {data.team.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <input className="cm-input" inputMode="decimal" placeholder={row?.stripeLinked ? "On Stripe — not needed" : "Monthly gross $ (no Stripe)"}
          value={gross} onChange={(e) => setGross(e.target.value.replace(/[^\d.]/g, ""))} aria-label="Monthly gross, per 28 days"
          disabled={!clientId || !data.settingsAvailable} />
        <button type="button" className="rx-btn solid" disabled={!clientId || saving} onClick={() => void submit()}>{saving ? "Saving…" : "Assign"}</button>
      </div>
      <p className="cm-note" style={{ margin: "8px 0 0" }}>
        Clients are created once, on <a href="/roster">Clients</a>. Salespeople and account managers are people on Team access with that role; the choices here are the same fields as on the client&rsquo;s record.
        {msg ? <span className={msg.bad ? "cm-bad" : "cm-ok"}> {msg.text}</span> : null}
      </p>
    </section>
  );
}
