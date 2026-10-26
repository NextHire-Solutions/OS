"use client";

import { useEffect, useRef, useState } from "react";

import { addDays, LEAD_SOURCE_UNIT, PAY_PER_LEAD_PRODUCTS, periodLabel, productLabel, type LeadSource } from "@/lib/clients/usage-billing/model";

/*
 * PAY PER LEAD — the TEST panel on a client's Billing tab (26 Oct 2026).
 *
 * The user: "we do not want to make this live for any of the client right
 * now. we just need to build this and make a way to test this." So this is
 * the way to test it, end to end, in Stripe TEST mode only: set the price and
 * cadence (which marks the client a TEST client), get a Checkout link to save
 * a card (Stripe's 4242 test card), preview the period's invoice from the lead
 * source or from typed-in fake leads, and run one test charge.
 *
 * Shown only to the Billing tab's people — the route answers everyone else
 * with a bare 404, and then this renders nothing. The route refuses any key
 * that is not a Stripe TEST key and any client not marked test_only.
 */

type Period = { start: string; end: string; label?: string; running?: boolean };
type Settings = {
  enabled: boolean; test_only: boolean; price_cents: number; every_days: number; anchor_date: string; lead_source: string;
  stripe_customer_id: string | null; default_payment_method_id: string | null; card_label: string | null;
};
type PeriodRow = {
  id: string; period_start: string; period_end: string; status: string; lead_count: number; amount_cents: number; lead_source: string;
  stripe_invoice_id: string | null; stripe_invoice_number: string | null; hosted_invoice_url: string | null; note: string | null; error: string | null;
};
type Invoice = { id: string; number: string | null; status: string; total: number; created: number; payUrl: string | null; hostedUrl: string | null; pdf: string | null };
type View = {
  settings: Settings | null; periods: PeriodRow[]; invoices: Invoice[] | null; invoicesError: string | null; today: string;
  keyState: "test" | "missing" | "refused"; refusal: string | null; flags: { scheduler: boolean; charge: boolean };
  schedule: { current: Period | null; lastCompleted: Period | null; firstStarts: string | null; choices: Period[] } | null;
  leadSources: Record<string, string>; defaultLeadSource: string;
};
type PreviewView = { label: string; count: number; amountCents: number; priceCents: number; lines: Array<{ description: string; amountCents: number }>; skipped: unknown[]; existing: PeriodRow | null };

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
/** "lead" / "call" / "introduction" — what one charge is for. */
const unitOf = (source: string | null | undefined) => LEAD_SOURCE_UNIT[source as LeadSource] ?? "lead";
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
/** The product a price and a lead source make — or "custom". */
const productOf = (price: string, source: string) => {
  const cents = Math.round(Number(String(price).replace(/[$,\s]/g, "")) * 100);
  return PAY_PER_LEAD_PRODUCTS.find((p) => p.leadSource === source && p.priceCents === cents)?.id ?? "custom";
};
const TONE: Record<string, string> = { paid: "good", failed: "bad", charged: "warn", draft: "warn", preview: "mute", void: "mute", open: "warn", uncollectible: "bad" };

export type UsageBillingView = View;

/** `initial`: a first answer to show before the route's (a render check uses it). */
export function UsageBillingPanel({ clientId, initial = null }: { clientId: string; initial?: View | null }) {
  const [view, setView] = useState<View | null>(initial);
  // Closed until asked for (it is a test tool on every client's Billing tab); open on the way back from Checkout.
  const [open, setOpen] = useState(initial !== null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ price: String(PAY_PER_LEAD_PRODUCTS[0].priceCents / 100), everyDays: "7", anchorDate: "", leadSource: PAY_PER_LEAD_PRODUCTS[0].leadSource as string, enabled: false });
  // "Custom price…" picked: the price and what is counted are typed, even if they happen to match a product.
  const [custom, setCustom] = useState(false);
  const product = custom ? "custom" : productOf(form.price, form.leadSource);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const [periodStart, setPeriodStart] = useState("");
  const [fakeLeads, setFakeLeads] = useState("");
  const [preview, setPreview] = useState<PreviewView | null>(null);
  const confirmedReturn = useRef(false);

  const load = async () => {
    try {
      const res = await fetch(`/api/workspace/clients/billing/usage?clientId=${encodeURIComponent(clientId)}`, { cache: "no-store" });
      if (res.status === 404 || res.status === 401) { setHidden(true); return; }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) { setError(body?.error ?? `HTTP ${res.status}`); return; }
      setView(body as View);
      const s = (body as View).settings;
      setForm((f) => s
        ? { price: String(s.price_cents / 100), everyDays: String(s.every_days), anchorDate: s.anchor_date, leadSource: s.lead_source, enabled: s.enabled }
        : { ...f, anchorDate: f.anchorDate || addDays((body as View).today, -7), leadSource: (body as View).defaultLeadSource });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    }
  };

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/workspace/clients/billing/usage", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, action, ...extra }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? body?.message ?? `HTTP ${res.status}`); return null; }
      return body;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return null;
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (new URL(window.location.href).searchParams.has("usage_setup")) setOpen(true);
  }, []);
  useEffect(() => { if (open) void load(); }, [clientId, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from the Checkout page: read the card once.
  useEffect(() => {
    if (confirmedReturn.current || !view?.settings || view.keyState !== "test") return;
    const u = new URL(window.location.href);
    if (u.searchParams.get("usage_setup") !== "done") return;
    confirmedReturn.current = true;
    u.searchParams.delete("usage_setup");
    window.history.replaceState(null, "", u);
    void (async () => {
      const r = await act("confirm_setup");
      if (r) { setNote(r.saved ? `Card saved: ${r.cardLabel ?? "card"}.` : "The Checkout is not complete yet."); await load(); }
    })();
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  if (hidden) return null;
  if (!open) {
    return (
      <section className="rx-sec cat-billing" data-testid="usage-billing">
        <div className="rb-head">
          <h3><i aria-hidden="true" />Pay per lead<span>test mode — not live for any client</span></h3>
          <button type="button" className="rx-btn" onClick={() => setOpen(true)}>Open the test panel</button>
        </div>
      </section>
    );
  }

  const s = view?.settings ?? null;
  const stripeOk = view?.keyState === "test";
  const sample = () => {
    const sch = view?.schedule;
    const p = periodStart ? sch?.choices.find((c) => c.start === periodStart) : sch?.lastCompleted ?? sch?.current;
    if (!p) return;
    setFakeLeads([1, 2, 3].map((i) => `Test Lead ${i}, ${addDays(p.start, Math.min(i - 1, 6))}`).join("\n"));
  };
  const leadsArg = fakeLeads.trim() ? { fakeLeads } : {};
  const periodArg = periodStart ? { periodStart } : {};

  return (
    <section className="rx-sec cat-billing" data-testid="usage-billing">
      <div className="rb-head">
        <h3><i aria-hidden="true" />Pay per lead<span>test mode — not live for any client</span></h3>
        <span className="rb-pill warn">STRIPE TEST MODE</span>
      </div>
      <p className="rx-hint" style={{ marginTop: 4 }}>
        A way to try pay-per-lead billing end to end with Stripe&apos;s test card (4242 4242 4242 4242). Nothing here can charge a real card:
        only Stripe test keys are accepted, and only clients saved here (marked as test clients) can be billed.
      </p>
      {view && !stripeOk ? (
        <div className="rx-bill-fail" role="alert" style={{ margin: "8px 0" }}>
          <b>{view.keyState === "missing" ? "No Stripe test key" : "Stripe key refused"}</b>
          <span>{view.keyState === "missing" ? "OS_USAGE_BILLING_STRIPE_KEY is not set on this server — saving and previews work; the card link and test charge are off." : "OS_USAGE_BILLING_STRIPE_KEY is not a Stripe TEST key, so every Stripe action is refused."}</span>
        </div>
      ) : null}
      {error ? <div className="ds-field-err" role="alert">{error}</div> : null}
      {note ? <p className="rx-hint" role="status" style={{ color: "var(--st-active)" }}>{note}</p> : null}
      {!view ? (error ? null : <p className="rx-hint" role="status">Loading…</p>) : (
        <>
          {s ? <p className="rx-hint" style={{ margin: "0 0 8px" }}>Product: <b>{productLabel(s.lead_source as LeadSource, s.price_cents)}</b> · every {s.every_days} days{s.enabled ? "" : " · not in the scheduled run"}</p> : null}
          {/* --------------------------------------------------- settings */}
          {/* The product first — the same five offered when a client is onboarded — or a custom price and what is counted. */}
          <div className="rb-tools ub-settings">
            <label className="rb-field ub-product"><span>Product</span>
              <select className="ds-input" value={product} onChange={(e) => {
                const p = PAY_PER_LEAD_PRODUCTS.find((x) => x.id === e.target.value);
                setCustom(!p);
                if (p) setForm({ ...form, price: String(p.priceCents / 100), leadSource: p.leadSource });
              }}>
                {PAY_PER_LEAD_PRODUCTS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                <option value="custom">Custom price…</option>
              </select>
            </label>
            {product === "custom" ? (
              <>
                <label className="rb-field ub-price"><span>Price per {unitOf(form.leadSource)} ($)</span>
                  <input className="ds-input" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
                </label>
                <label className="rb-field ub-source"><span>What is counted</span>
                  <select className="ds-input" value={form.leadSource} onChange={(e) => setForm({ ...form, leadSource: e.target.value })}>
                    {Object.entries(view.leadSources).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                </label>
              </>
            ) : null}
            <label className="rb-field ub-every"><span>Bill every</span>
              <select className="ds-input" value={form.everyDays} onChange={(e) => setForm({ ...form, everyDays: e.target.value })}>
                <option value="7">7 days</option>
                <option value="14">14 days</option>
              </select>
            </label>
            <label className="rb-field ub-date"><span>First period starts</span>
              <input className="ds-input" type="date" value={form.anchorDate} onChange={(e) => setForm({ ...form, anchorDate: e.target.value })} />
            </label>
          </div>
          <div className="rb-tools ub-save">
            <label className="ub-check" title="The scheduled run only exists when OS_USAGE_BILLING_ENABLED=1 is set on Railway">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> In the scheduled run
            </label>
            <span className="sp" />
            <button type="button" className="rx-btn solid" disabled={!!busy} onClick={async () => {
              const r = await act("save", { price: form.price, everyDays: Number(form.everyDays), anchorDate: form.anchorDate, leadSource: form.leadSource, enabled: form.enabled });
              if (r) { setNote(s ? "Saved." : "Saved — this client is now a TEST client for pay per lead."); setPreview(null); await load(); }
            }}>{busy === "save" ? "Saving…" : s ? "Save" : "Save as test client"}</button>
          </div>
          {view.refusal && s ? <p className="ds-field-err">{view.refusal}</p> : null}

          {s && !view.refusal ? (
            <>
              <div className="rb-grid">
                <div><small>Price</small><b>{money(s.price_cents)}</b><span>per {unitOf(s.lead_source)}</span></div>
                <div><small>Every</small><b>{s.every_days} days</b><span>from {s.anchor_date}</span></div>
                <div><small>Current period</small><b>{view.schedule?.current?.label ?? "—"}</b><span>{view.schedule?.firstStarts ? `starts ${view.schedule.firstStarts}` : view.schedule?.current ? `billed from ${view.schedule.current.end}` : ""}</span></div>
                <div><small>Card</small><b>{s.card_label ?? "None yet"}</b><span>{s.stripe_customer_id ? `test customer ${s.stripe_customer_id}` : "no Stripe customer yet"}</span></div>
                <div><small>Scheduled run</small><b>{view.flags.scheduler ? (view.flags.charge ? "Charging" : "Previews only") : "Off"}</b><span>{s.enabled ? "this client is in it" : "this client is not in it"}</span></div>
              </div>

              {/* ----------------------------------------------- the card */}
              <div className="rb-tools">
                <button type="button" className="rx-btn" disabled={!!busy || !stripeOk} onClick={async () => {
                  const r = await act("setup_link");
                  if (r?.url) setSetupUrl(r.url);
                }}>{busy === "setup_link" ? "Making link…" : s.card_label ? "New card-setup link" : "Get card-setup link"}</button>
                <button type="button" className="rx-btn" disabled={!!busy || !stripeOk || !s.stripe_customer_id} onClick={async () => {
                  const r = await act("confirm_setup");
                  if (r) { setNote(r.saved ? `Card saved: ${r.cardLabel ?? "card"}.` : `The Checkout is ${r.status ?? "not complete"} — finish it, then check again.`); await load(); }
                }}>{busy === "confirm_setup" ? "Checking…" : "Check card"}</button>
                {setupUrl ? (
                  <>
                    <input className="ds-input" readOnly value={setupUrl} style={{ flex: 1, minWidth: 200 }} onFocus={(e) => e.currentTarget.select()} aria-label="Card-setup link" />
                    <a className="rx-btn" href={setupUrl} target="_blank" rel="noreferrer">Open ↗</a>
                  </>
                ) : null}
              </div>

              {/* ---------------------------------- preview and test charge */}
              <div className="rb-tools" style={{ alignItems: "flex-end" }}>
                <label className="rb-field"><span>Period</span>
                  <select className="ds-input" style={{ width: 300 }} value={periodStart} onChange={(e) => { setPeriodStart(e.target.value); setPreview(null); }}>
                    <option value="">Default — the last period that has ended</option>
                    {(view.schedule?.choices ?? []).map((p) => <option key={p.start} value={p.start}>{p.label}{p.running ? " (still running — test only)" : ""}</option>)}
                  </select>
                </label>
                <label className="rb-field" style={{ flex: 1, minWidth: 240 }}><span>Fake leads (optional) — one per line: Name, YYYY-MM-DD <button type="button" className="rb-chip" onClick={sample}>Fill 3 samples</button></span>
                  <textarea className="ds-input" rows={3} value={fakeLeads} placeholder="Empty: the real leads from the lead source" onChange={(e) => { setFakeLeads(e.target.value); setPreview(null); }} style={{ height: "auto", padding: "8px 11px" }} />
                </label>
              </div>
              <div className="rb-tools">
                <button type="button" className="rx-btn" disabled={!!busy} onClick={async () => {
                  const r = await act("preview", { ...periodArg, ...leadsArg });
                  if (r?.preview) setPreview(r.preview as PreviewView);
                }}>{busy === "preview" ? "Reading leads…" : "Preview invoice"}</button>
                <button type="button" className="rx-btn solid" disabled={!!busy || !stripeOk || !s.default_payment_method_id || !preview || preview.count === 0} title={!s.default_payment_method_id ? "Save a test card first" : !preview ? "Preview first" : undefined} onClick={async () => {
                  if (!preview || !window.confirm(`Charge ${money(preview.amountCents)} for ${plural(preview.count, unitOf(s.lead_source))} (${preview.label}) to the TEST card ${s.card_label ?? ""}?\n\nStripe test mode — no real money moves.`)) return;
                  const r = await act("charge", { ...periodArg, ...leadsArg });
                  if (r) setNote(`${r.message}${r.invoice ? ` Invoice ${r.invoice.number ?? r.invoice.id}: ${money(r.invoice.total)}, ${r.invoice.status}.` : ""}`);
                  setPreview(null);
                  await load();
                }}>{busy === "charge" ? "Charging the test card…" : "Run test charge"}</button>
              </div>
              {preview ? (
                <div className="rb-scroll" data-testid="usage-preview">
                  <p className="rx-hint" style={{ margin: "0 0 6px" }}>
                    {preview.label}: <b>{plural(preview.count, unitOf(s.lead_source))} × {money(preview.priceCents)} = {money(preview.amountCents)}</b>
                    {preview.skipped.length ? ` · ${preview.skipped.length} not billed (already billed, or the same agent twice)` : ""}
                    {preview.existing && preview.existing.status !== "preview" ? ` · this period is already ${preview.existing.status}` : ""}
                  </p>
                  {preview.lines.length ? (
                    <table className="rb-table">
                      <thead><tr><th>Invoice line</th><th className="num">Amount</th></tr></thead>
                      <tbody>{preview.lines.map((l, i) => <tr key={i}><td>{l.description}</td><td className="num">{money(l.amountCents)}</td></tr>)}</tbody>
                    </table>
                  ) : <p className="rx-hint">Nothing billable in this period — nothing would be charged.</p>}
                </div>
              ) : null}

              {/* -------------------------------------------- the periods */}
              {view.periods.length ? (
                <div className="rb-scroll" style={{ marginTop: 12 }}>
                  <table className="rb-table" data-testid="usage-periods">
                    <thead><tr><th>Period</th><th className="num">Billed</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
                    <tbody>
                      {view.periods.map((p) => (
                        <tr key={p.id}>
                          <td>{periodLabel({ start: p.period_start, end: p.period_end })}{p.error || p.note ? <small>{p.error ?? p.note}</small> : null}</td>
                          <td className="num">{p.lead_count}</td>
                          <td className="num">{money(p.amount_cents)}</td>
                          <td><span className={`rb-pill ${TONE[p.status] ?? "mute"}`}>{p.status}</span></td>
                          <td className="rb-links">
                            {p.hosted_invoice_url ? <a href={p.hosted_invoice_url} target="_blank" rel="noreferrer">{p.status === "failed" ? "Pay link ↗" : "Invoice ↗"}</a> : null}
                            {(p.status === "charged" || p.status === "failed") && stripeOk ? (
                              <button type="button" className="rb-chip" style={{ marginLeft: 8 }} disabled={!!busy} onClick={async () => { if (await act("refresh", { periodStart: p.period_start })) await load(); }}>Refresh</button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {/* ------------------------------- Stripe's own record (test) */}
              {view.invoices?.length ? (
                <div className="rb-scroll" style={{ marginTop: 12 }}>
                  <table className="rb-table">
                    <thead><tr><th>Test-mode invoice</th><th>Date</th><th className="num">Total</th><th>Status</th><th /></tr></thead>
                    <tbody>
                      {view.invoices.map((i) => (
                        <tr key={i.id}>
                          <td>{i.number ?? i.id}</td>
                          <td className="day">{new Date(i.created * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                          <td className="num">{money(i.total)}</td>
                          <td><span className={`rb-pill ${TONE[i.status] ?? "mute"}`}>{i.status}</span></td>
                          <td className="rb-links">
                            {i.payUrl ? <a href={i.payUrl} target="_blank" rel="noreferrer">Pay ↗</a> : i.hostedUrl ? <a href={i.hostedUrl} target="_blank" rel="noreferrer">View ↗</a> : null}
                            {i.pdf ? <a href={i.pdf} target="_blank" rel="noreferrer">PDF ↓</a> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : view.invoicesError ? <p className="ds-field-err">Stripe (test) could not be read: {view.invoicesError}</p> : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
