"use client";

import { useEffect, useState } from "react";

import { fmtDay } from "@/components/clients/cells";
import { RefundDialog } from "@/components/screens/client-billing-refund";
import { givenBack } from "@/lib/clients/billing-refund";
import { csvText, type CsvCell } from "@/lib/clients/billing-csv";
import type { BillingHistoryRow, BillingInvoiceRow, BillingNowView, ClientBillingDetail } from "@/lib/clients/billing-model";

/*
 * THE BILLING TAB (Eddy, 17 Oct): "a centralized Billing section for each
 * client showing current billing, total billed, billing history including
 * failed payments and refunds, and invoice history with the ability to view
 * and download them — all in one place, synced with Stripe."
 *
 * It reads /api/workspace/clients/billing/history and opens invoices and
 * receipts through /billing/document. The one write is Refund on a paid
 * invoice (22 Oct, client-billing-refund.tsx). Pausing, resuming and linking
 * stay in the Stripe control under it, unchanged.
 */

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const cap = (s: string) => s.replace(/^\w/, (x) => x.toUpperCase());

/** Days from today (Eastern) to an Eastern day. */
function daysTo(day: string): number {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}
const inDays = (day: string) => {
  const n = daysTo(day);
  return n === 0 ? "today" : n > 0 ? `in ${plural(n, "day")}` : `${plural(-n, "day")} ago`;
};

function ago(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** What the payment-status cell says. */
export function payStatus(n: BillingNowView): { label: string; detail: string | null } {
  const unpaid = n.unpaid > 0 ? `${money(n.unpaid)} unpaid` : null;
  switch (n.state) {
    case "paid": return { label: "Paid", detail: null };
    case "failed": return { label: "Payment failed", detail: `${money(n.unpaid)} unpaid on ${plural(n.failedInvoices, "invoice")}` };
    case "past_due": return { label: "Past due", detail: "Stripe is retrying the payment" };
    case "open": return { label: "Invoice open", detail: n.due !== null ? `${money(n.due)} due` : null };
    case "uncollectible": return { label: "Unpaid", detail: "the last invoice was marked uncollectible" };
    case "paused": return { label: "Paused", detail: unpaid ?? "no charges while paused" };
    case "cancelled": return { label: "Cancelled", detail: n.canceled ? `on ${fmtDay(n.canceled)}` : null };
    case "trial": return { label: "Trial", detail: null };
    case "incomplete": return { label: "Incomplete", detail: "the first payment was not made" };
    default: return { label: "Collecting", detail: null };
  }
}

/* ---------------------------------------------------------------- CSV --- */

function downloadCsv(name: string, header: string[], rows: CsvCell[][]) {
  const blob = new Blob([`﻿${csvText(header, rows)}`], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[\\/:*?"<>|]+/g, " ").trim()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1_000);
}

const today = () => new Date().toISOString().slice(0, 10);

/* -------------------------------------------------------------- the tab --- */

export function ClientBillingTab({ clientId, clientName, plan }: { clientId: string; clientName: string; plan: string | null }) {
  const [state, setState] = useState<{ detail?: ClientBillingDetail; error?: string; hidden?: true } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (fresh = false) => {
    if (fresh) setRefreshing(true);
    try {
      const res = await fetch(`/api/workspace/clients/billing/history?clientId=${encodeURIComponent(clientId)}${fresh ? "&fresh=1" : ""}`, { cache: "no-store" });
      if (res.status === 401 || res.status === 403) { setState({ hidden: true }); return; }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.detail) setState((s) => ({ detail: s?.detail, error: body?.error ?? `HTTP ${res.status}` }));
      else setState({ detail: body.detail });
    } catch (e) {
      setState((s) => ({ detail: s?.detail, error: e instanceof Error ? e.message : "Stripe could not be read" }));
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => { void load(); }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state?.hidden) {
    return <section className="rx-sec"><p className="rx-hint">Billing is shown to admins and people with the Clients page.</p></section>;
  }
  if (!state || (!state.detail && !state.error)) {
    return (
      <section className="rx-sec cat-billing">
        <h3><i aria-hidden="true" />Current billing</h3>
        <p className="rx-hint" role="status" style={{ marginTop: 6 }}>Reading Stripe…</p>
      </section>
    );
  }
  if (!state.detail) {
    return (
      <section className="rx-sec cat-billing">
        <h3><i aria-hidden="true" />Current billing</h3>
        <div className="rx-bill-fail" role="alert" style={{ marginTop: 8 }}>
          <b>Stripe could not be read</b>
          <span>{state.error}</span>
          <span><button type="button" className="rx-btn" onClick={() => { setState(null); void load(); }}>Try again</button></span>
        </div>
      </section>
    );
  }

  const d = state.detail;
  const n = d.now;
  const status = n ? payStatus(n) : null;
  const refunds = d.history.filter((h) => h.kind === "refund");
  const docUrl = (id: string, as?: "page" | "pdf") =>
    `/api/workspace/clients/billing/document?clientId=${encodeURIComponent(clientId)}&id=${encodeURIComponent(id)}${as ? `&as=${as}` : ""}`;

  return (
    <div className="rb">
      {/* ------------------------------------------------ current billing */}
      <section className="rx-sec cat-billing">
        <div className="rb-head">
          <h3><i aria-hidden="true" />Current billing</h3>
          <span className="rb-sync" data-testid="rb-sync">
            {d.readAt ? <>From Stripe · read {ago(d.readAt)}</> : "From Stripe"}
            <button type="button" disabled={refreshing} onClick={() => void load(true)}>{refreshing ? "Reading Stripe…" : "Refresh"}</button>
          </span>
        </div>
        {state.error ? <div className="ds-field-err" role="alert">Refresh failed: {state.error}. Showing the last read.</div> : null}
        {n && status ? (
          <div className="rb-grid" data-testid="rb-now">
            <div>
              <small>Plan</small>
              <b>{plan ?? "—"}</b>
              <span title="The product in Stripe">{n.product ?? "—"}</span>
            </div>
            <div>
              <small>Amount</small>
              <b>{money(n.amount)}</b>
              <span>{n.listAmount !== null ? `${money(n.listAmount)} less ${n.percentOff}%` : "per charge"}</span>
            </div>
            <div>
              <small>Frequency</small>
              <b>{n.every ? cap(n.every) : "—"}</b>
              <span>since {fmtDay(n.since)}</span>
            </div>
            <div>
              <small>Next billing</small>
              {n.state === "cancelled" ? <><b>—</b><span>no more charges</span></>
                : n.state === "paused" ? <><b>{n.nextBilling ? fmtDay(n.nextBilling) : "—"}</b><span>{n.nextBilling ? `resumes ${inDays(n.nextBilling)}` : "paused until resumed"}</span></>
                : n.nextBilling ? <><b>{fmtDay(n.nextBilling)}</b><span>{inDays(n.nextBilling)}</span></>
                : <><b>—</b><span>not scheduled</span></>}
            </div>
            <div>
              <small>Payment status</small>
              <b className={`rb-tone ${n.tone}`}>{status.label}</b>
              <span>{status.detail ?? (d.totals.lastPayment ? `last paid ${money(d.totals.lastPayment.amount)}, ${fmtDay(d.totals.lastPayment.date)}` : "no payment yet")}</span>
            </div>
          </div>
        ) : (
          <p className="rx-hint" style={{ marginTop: 6 }}>No Stripe subscription for this client. Link one or create one under <b>Subscriptions and Stripe</b> below.</p>
        )}
        {d.otherLive ? (
          <p className="rx-hint" style={{ marginTop: 0 }}>
            The client has {plural(d.otherLive, "other subscription")} not cancelled — every subscription is listed under <b>Subscriptions and Stripe</b> below.
          </p>
        ) : null}
      </section>

      {/* ---------------------------------------------------- total billed */}
      <section className="rx-sec">
        <h3>Total billed<span>{d.totals.firstPayment ? `every payment since ${fmtDay(d.totals.firstPayment)}` : "no payments yet"}</span></h3>
        <div className="rb-grid" data-testid="rb-totals">
          <div>
            <small>Total billed</small>
            <b>{money(d.totals.net)}</b>
            <span>paid, less refunds</span>
          </div>
          <div>
            <small>Charged</small>
            <b>{money(d.totals.charged)}</b>
            <span>{plural(d.totals.payments, "payment")}</span>
          </div>
          <div>
            <small>Refunded</small>
            <b>{money(d.totals.refunded)}</b>
            <span>{refunds.length ? plural(refunds.length, "refund") : "none"}</span>
          </div>
          <div>
            <small>Failed payments</small>
            <b className={d.totals.failed ? "rb-tone bad" : undefined}>{d.totals.failed.toLocaleString("en-US")}</b>
            <span className={d.totals.unpaid > 0 ? "rb-tone bad" : undefined}>{d.totals.unpaid > 0 ? `${money(d.totals.unpaid)} unpaid now` : "nothing unpaid"}</span>
          </div>
        </div>
      </section>

      <History rows={d.history} clientName={clientName} docUrl={docUrl} />
      <Invoices rows={d.invoices} clientId={clientId} clientName={clientName} docUrl={docUrl} onRefunded={() => void load(true)} />
    </div>
  );
}

/* -------------------------------------------------------------- history --- */

const KIND: Record<BillingHistoryRow["kind"], { label: string; tone: string }> = {
  payment: { label: "Paid", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  pending: { label: "Processing", tone: "warn" },
  refund: { label: "Refund", tone: "mute" },
};
const SHOW = 15;

function History({ rows, clientName, docUrl }: { rows: BillingHistoryRow[]; clientName: string; docUrl: (id: string, as?: "page" | "pdf") => string }) {
  const [only, setOnly] = useState<"all" | "payment" | "failed" | "refund">("all");
  const [all, setAll] = useState(false);
  const count = (k: BillingHistoryRow["kind"]) => rows.filter((r) => r.kind === k).length;
  const shown = rows.filter((r) => only === "all" || r.kind === only || (only === "payment" && r.kind === "pending"));
  const visible = all ? shown : shown.slice(0, SHOW);
  const csv = () => downloadCsv(`${clientName} billing history ${today()}`,
    ["Date", "Type", "Description", "Amount (USD)", "Card", "Invoice", "Note", "Stripe id"],
    rows.map((r) => [r.date, KIND[r.kind].label, r.description, r.kind === "refund" ? -r.amount : r.amount, r.card, r.invoiceNumber, r.note, r.id]));

  return (
    <section className="rx-sec">
      <h3>Billing history<span>{rows.length ? `${plural(count("payment"), "payment")} · ${count("failed")} failed · ${plural(count("refund"), "refund")}` : "nothing charged yet"}</span></h3>
      {rows.length ? (
        <>
          <div className="rb-tools">
            {(["all", "payment", "failed", "refund"] as const).map((k) => (
              <button key={k} type="button" className="rb-chip" aria-pressed={only === k} onClick={() => { setOnly(k); setAll(false); }}>
                {k === "all" ? `All ${rows.length}` : k === "payment" ? `Payments ${count("payment") + count("pending")}` : k === "failed" ? `Failed ${count("failed")}` : `Refunds ${count("refund")}`}
              </button>
            ))}
            <span className="sp" />
            <button type="button" className="rx-btn" onClick={csv}>Download CSV</button>
          </div>
          <div className="rb-scroll">
            <table className="rb-table" data-testid="rb-history">
              <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} className={`k-${r.kind}`}>
                    <td className="day">{fmtDay(r.date)}</td>
                    <td>
                      {r.kind === "refund" ? <>Refund — {r.description}</> : r.description}
                      {r.card || r.note || r.by || r.creditNote ? (
                        <small>{[r.card, r.note, r.creditNote ? `credit note ${r.creditNote}` : null, r.by ? `by ${r.by}` : null].filter(Boolean).join(" · ")}</small>
                      ) : null}
                    </td>
                    <td className="num">{r.kind === "refund" ? `−${money(r.amount)}` : money(r.amount)}</td>
                    <td><span className={`rb-pill ${KIND[r.kind].tone}`}>{KIND[r.kind].label}</span></td>
                    <td className="rb-links">
                      {r.receipt ? <a href={docUrl(r.id)} target="_blank" rel="noreferrer">Receipt ↗</a> : null}
                      {r.invoiceId ? <a href={docUrl(r.invoiceId, "page")} target="_blank" rel="noreferrer" title={`Invoice ${r.invoiceNumber ?? r.invoiceId}`}>Invoice ↗</a> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length > SHOW ? (
            <button type="button" className="rx-go rb-more" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${shown.length}`}</button>
          ) : null}
        </>
      ) : <p className="rx-hint" style={{ marginTop: 6 }}>No payments in Stripe for this client yet.</p>}
    </section>
  );
}

/* ------------------------------------------------------------- invoices --- */

function Invoices({ rows, clientId, clientName, docUrl, onRefunded }: {
  rows: BillingInvoiceRow[]; clientId: string; clientName: string; docUrl: (id: string, as?: "page" | "pdf") => string; onRefunded: () => void;
}) {
  const [all, setAll] = useState(false);
  const [refunding, setRefunding] = useState<BillingInvoiceRow | null>(null);
  const visible = all ? rows : rows.slice(0, SHOW);
  const csv = () => downloadCsv(`${clientName} invoices ${today()}`,
    ["Invoice", "Date", "Period start", "Period end", "Total (USD)", "Paid (USD)", "Unpaid (USD)", "Status", "Paid on", "Payment attempts", "Description", "Stripe id"],
    rows.map((i) => [i.number, i.date, i.periodStart, i.periodEnd, i.total, i.paid, i.remaining, i.label, i.paidOn, i.attempts, i.description, i.id]));
  const period = (i: BillingInvoiceRow) =>
    i.periodStart && i.periodEnd && i.periodStart !== i.periodEnd ? `${fmtDay(i.periodStart)?.replace(/, \d{4}$/, "")} – ${fmtDay(i.periodEnd)}` : null;

  return (
    <section className="rx-sec">
      <h3>Invoices<span>{rows.length ? `${plural(rows.length, "invoice")} · view in Stripe or download the PDF` : "none yet"}</span></h3>
      {rows.length ? (
        <>
          <div className="rb-tools">
            <span className="sp" />
            <button type="button" className="rx-btn" onClick={csv}>Download CSV</button>
          </div>
          <div className="rb-scroll">
            <table className="rb-table" data-testid="rb-invoices">
              <thead><tr><th>Invoice</th><th>Date</th><th className="num">Total</th><th className="num">Paid</th><th>Status</th><th /></tr></thead>
              <tbody>
                {visible.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.number ?? (i.status === "draft" ? "Draft" : i.id)}
                      {period(i) || i.description ? <small>{period(i) ?? i.description}</small> : null}
                    </td>
                    <td className="day">{fmtDay(i.date)}</td>
                    <td className="num">{money(i.total)}</td>
                    <td className="num">
                      {money(i.paid)}
                      {i.remaining > 0 && i.status === "open" ? <small>{money(i.remaining)} unpaid</small>
                        : i.status === "paid" && i.card && givenBack(i) ? <small>{givenBack(i)}</small> : null}
                    </td>
                    <td>
                      <span className={`rb-pill ${i.tone}`}>{i.label}</span>
                      {i.status === "open" && i.attempts > 0 ? <small>{plural(i.attempts, "try", "tries")}</small> : null}
                    </td>
                    <td className="rb-links">
                      {i.page ? <a href={docUrl(i.id, "page")} target="_blank" rel="noreferrer">View ↗</a> : null}
                      {i.pdf ? <a href={docUrl(i.id, "pdf")} target="_blank" rel="noreferrer">PDF ↓</a> : null}
                      {i.refundable > 0 && i.card ? <button type="button" className="rb-refund" onClick={() => setRefunding(i)}>Refund</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > SHOW ? (
            <button type="button" className="rx-go rb-more" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>
          ) : null}
        </>
      ) : <p className="rx-hint" style={{ marginTop: 6 }}>No invoices in Stripe for this client yet.</p>}
      {refunding ? <RefundDialog clientId={clientId} invoice={refunding} onClose={() => setRefunding(null)} onRefunded={onRefunded} /> : null}
    </section>
  );
}
