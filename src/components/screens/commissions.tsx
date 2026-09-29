"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { CommissionRow, CommissionsView, RepSummary } from "@/lib/commissions/load";
import { planLabel } from "@/components/clients/cells";

import { PlaceholderScreen } from "./lazy";

/*
 * COMMISSIONS — sales payouts, by account manager.
 *
 * Built from the client's mockup (commissions-mockup.html): the next payout
 * run, the account manager's card with what is due, their clients, an admin
 * section, and the three rules. What changed from the mockup, and why:
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

  return (
    <div className="cx-page" aria-busy={busy}>
      {/* ---------------------------------------------------------- header */}
      <header className="cm-head">
        <div className="cx-head-t">
          <span className="cx-kicker">Workspace</span>
          <h1>Commissions</h1>
          <p>Sales payouts — each account manager earns on the clients they manage. Payouts run on the 1st and 15th.</p>
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
            <select className="cm-select" value={data.scope} onChange={(e) => onAs(e.target.value)} aria-label="Account manager to view">
              <option value="all">All account managers</option>
              {data.people.map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}
            </select>
            <span className="cm-note">— account managers see only their own clients and payouts. You are an admin, so you can see everyone.</span>
          </>
        ) : (
          <span>Signed in as <b>{data.viewer.name}</b><span className="cm-note"> — you see only your own clients and payouts.</span></span>
        )}
      </div>

      {data.viewer.admin && !data.settingsAvailable ? (
        <p className="ds-note" style={{ margin: 0 }}>
          <b>Rates and manual gross amounts can&rsquo;t be saved yet.</b> Run <code>migrations/0019_commissions.sql</code> in Supabase once.
          Until then every account manager is on 70% / 15%, and only clients linked to Stripe are counted.
        </p>
      ) : null}
      {error ? <p className="ds-note" style={{ margin: 0 }}><b>Could not refresh.</b> {error}</p> : null}
      {data.unavailable.length ? <p className="ds-note" style={{ margin: 0 }}>Not read this time: {data.unavailable.join(", ")}.</p> : null}

      {/* ------------------------------------------------------- rep cards */}
      <section className="cm-reps" aria-label="Due per account manager">
        {(single && shown ? [shown] : data.reps).map((r) => (
          <RepCard key={r.email} rep={r} run={data.run} admin={data.viewer.admin} canSave={data.settingsAvailable}
            onPick={single ? undefined : () => onAs(r.email)} onChanged={onChanged} />
        ))}
        {data.reps.length === 0 ? <p className="cm-empty">No account managers yet — invite them on Team access, then assign clients below.</p> : null}
      </section>

      {/* ----------------------------------------------------------- table */}
      <section className="cx-panel">
        <div className="cx-toolbar">
          <span className="cm-title">{single ? (data.viewer.admin ? `${shown?.name ?? ""}’s clients` : "My clients") : "Clients by account manager"}</span>
          <span className="cx-toolbar-r">
            <span className="cx-count">{data.rows.length} <em>clients</em></span>
            <span className="cm-total">Due {day(data.run)} <b>{money(total, true)}</b></span>
          </span>
        </div>
        <div className="cx-scroll" style={{ maxHeight: "none", minHeight: 0 }}>
          <table className="cx-table cm-table">
            <thead>
              <tr className="cx-cols">
                {["Client", "Plan", "Monthly (gross)", "Account manager", "Status", `Due ${day(data.run)}`].map((h, i) => (
                  <th key={h} className={i === 0 ? "cx-pin" : i === 2 || i === 5 ? "num" : undefined}><span className="cx-thl">{h}</span></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr><td colSpan={6} className="cx-empty">{single ? "No clients are assigned to this account manager yet." : "No client has an account manager yet."}</td></tr>
              ) : data.rows.map((r) => (
                <Row key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------------------------------------------------------- admin */}
      {data.viewer.admin ? <Assign data={data} onChanged={onChanged} /> : null}

      {/* ---------------------------------------------------------- rules */}
      <section>
        <div className="cm-h2">How payouts are calculated</div>
        <div className="cm-rules">
          <div><span className="k">Month 1</span><p>Earns <b>70%</b> of the client&rsquo;s first month of payments — the first 28 days of billing (two 14-day payments, or one 28-day). Paid on the next payout date after each payment.</p></div>
          <div><span className="k">Month 2+</span><p>Earns the account manager&rsquo;s residual rate — <b>15%</b> or <b>25%</b> — of every later payment, for as long as the client stays active. A client with more than one account manager is earned once, by the first one named.</p></div>
          <div><span className="k">On cancellation</span><p>Nothing accrues from the cancellation date. Paused billing collects nothing, so nothing accrues while paused either.</p></div>
        </div>
      </section>

      <footer className="cm-foot">
        Payouts run on the 1st and 15th of each month · amounts are paid Stripe invoices on the client&rsquo;s subscription · a client
        not linked to Stripe uses a gross an admin entered, estimated on its billing schedule and marked Estimate.
      </footer>
    </div>
  );
}

function RepCard({ rep, run, admin, canSave, onPick, onChanged }: {
  rep: RepSummary; run: string; admin: boolean; canSave: boolean; onPick?: () => void; onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function setResidual(v: number) {
    setSaving(true); setErr(null);
    try {
      const res = await fetch("/api/workspace/commissions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "rates", email: rep.email, residualRate: v, monthOneRate: rep.rates.monthOne }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); } finally { setSaving(false); }
  }
  const parts = [rep.residual ? `${rep.residual} residual` : null, rep.month1 ? `${rep.month1} first-month` : null].filter(Boolean).join(", ");
  return (
    <div className="cm-rep">
      <div className="cm-rep-top">
        {onPick ? <button type="button" className="cm-rep-name link" onClick={onPick}>{rep.name}</button> : <span className="cm-rep-name">{rep.name}</span>}
        <span className="cm-rate">
          {pct(rep.rates.monthOne)} MONTH 1 ·{" "}
          {admin && canSave ? (
            <select className="cm-rate-sel" value={rep.rates.residual} disabled={saving} aria-label={`${rep.name}'s residual rate`}
              onChange={(e) => void setResidual(Number(e.target.value))}>
              <option value={0.15}>15%</option>
              <option value={0.25}>25%</option>
            </select>
          ) : pct(rep.rates.residual)}{" "}RESIDUAL
        </span>
      </div>
      <div className="cm-due">
        <div>
          <span className="k">Due {day(run)}</span>
          <small>{rep.clients} client{rep.clients === 1 ? "" : "s"}{parts ? ` · ${parts}` : ""}</small>
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
        <td>{r.accountManager ?? <span className="cx-none">—</span>}</td>
        <td><span className={`cm-status ${tone}`}>{r.statusLabel}</span></td>
        <td className="num"><b className={r.due ? "cx-strong" : "cx-none"}>{money(r.due, true)}</b></td>
      </tr>
      {open ? (
        <tr className="cm-lines cx-static">
          <td colSpan={6}>
            {r.lines.length ? (
              <table>
                <thead><tr><th>Billed</th><th>Payment</th><th>Source</th><th>Kind</th><th className="num">Rate</th><th className="num">Commission</th></tr></thead>
                <tbody>
                  {r.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{day(l.date, true)}</td><td>{money(l.amount, true)}</td><td>{l.source === "stripe" ? "Stripe · paid" : "Estimate"}</td>
                      <td>{l.kind === "month1" ? "Month 1" : "Residual"}</td><td className="num">{pct(l.rate)}</td><td className="num">{money(l.commission, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <span className="cm-note">No payment falls on this run.</span>}
            <span className="cm-note">Earned to date on this client: <b>{money(r.lifetime, true)}</b>{r.lastPayment ? ` · last payment ${day(r.lastPayment, true)}` : ""}{!r.stripeLinked ? " · not linked to Stripe" : ""}</span>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* Admin: give a client its account manager (and, if it has no Stripe link, a gross). */
function Assign({ data, onChanged }: { data: CommissionsView; onChanged: () => void }) {
  const [clientId, setClientId] = useState("");
  const [am, setAm] = useState("");
  const [gross, setGross] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const row = data.rows.find((r) => r.id === clientId);
  const choices = [
    ...data.unassigned.map((c) => ({ id: c.id, name: c.name, note: "no account manager" })),
    ...data.rows.map((r) => ({ id: r.id, name: r.name, note: r.accountManager ?? "" })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  useEffect(() => {
    setAm(row?.accountManager ?? "");
    setGross(row?.manualGross != null ? String(row.manualGross) : "");
  }, [clientId, row?.accountManager, row?.manualGross]);

  async function submit() {
    if (!clientId) return;
    setSaving(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { kind: "assign", clientId, accountManager: am };
      if (data.settingsAvailable) body.monthlyGross = gross.trim() === "" ? null : Number(gross);
      const res = await fetch("/api/workspace/commissions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => null);
      if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
      setMsg({ text: `Saved — ${choices.find((c) => c.id === clientId)?.name ?? "client"} ${am ? `is managed by ${am}` : "has no account manager"}.` });
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
        <select className="cm-select" value={am} onChange={(e) => setAm(e.target.value)} aria-label="Account manager" disabled={!clientId}>
          <option value="">No account manager</option>
          {/* A client with several account managers keeps them unless a single one is picked. */}
          {am && !data.team.includes(am) ? <option value={am}>{am}</option> : null}
          {data.team.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <input className="cm-input" inputMode="decimal" placeholder={row?.stripeLinked ? "On Stripe — not needed" : "Monthly gross $ (no Stripe)"}
          value={gross} onChange={(e) => setGross(e.target.value.replace(/[^\d.]/g, ""))} aria-label="Monthly gross, per 28 days"
          disabled={!clientId || !data.settingsAvailable} />
        <button type="button" className="rx-btn solid" disabled={!clientId || saving} onClick={() => void submit()}>{saving ? "Saving…" : "Assign"}</button>
      </div>
      <p className="cm-note" style={{ margin: "8px 0 0" }}>
        Clients are created once, on <a href="/roster">Clients</a>. Account managers are Team access members; the choice here is the same field as on the client&rsquo;s record.
        {msg ? <span className={msg.bad ? "cm-bad" : "cm-ok"}> {msg.text}</span> : null}
      </p>
    </section>
  );
}
