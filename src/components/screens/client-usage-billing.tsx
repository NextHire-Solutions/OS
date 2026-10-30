"use client";

import { useEffect, useRef, useState } from "react";

import { addDays, LEAD_SOURCE_UNIT, leadsHash, PAY_PER_LEAD_PRODUCTS, periodLabel, productLabel, type BillableLead, type LeadSource } from "@/lib/clients/usage-billing/model";

/*
 * PAY PER LEAD on a client's Billing tab (26 Oct 2026; live clients 31 Oct).
 *
 * A client starts as a TEST client: its price and schedule are saved here, and
 * everything can be tried in Stripe test mode — a card-setup page for Stripe's
 * 4242 card, typed-in fake leads, test charges. It goes LIVE when a person here
 * connects the card the client already has on file in Stripe ("Go live"). A
 * live client is charged one period at a time, by a person: pick a period that
 * has ended, preview its leads, then charge the amount shown. What they saw —
 * the period, the leads, the amount, the client's mode and card — goes with the
 * charge, and the server charges only exactly that (route.ts `approved`); a page
 * left open from before a change is refused, never charged. Confirmations for
 * going live, a charge and a retry are spelled out on the page, by the button
 * pressed, with the focus moved to them; so are errors.
 *
 * Shown only to the Billing tab's people — the route answers everyone else
 * with a bare 404, and then this renders nothing.
 */

type Period = { start: string; end: string; label?: string; running?: boolean };
type Settings = {
  enabled: boolean; test_only: boolean; price_cents: number; every_days: number; anchor_date: string; lead_source: string;
  stripe_customer_id: string | null; default_payment_method_id: string | null; card_label: string | null; setup_session_id?: string | null;
};
type PeriodRow = {
  id: string; period_start: string; period_end: string; status: string; lead_count: number; amount_cents: number; lead_source: string;
  leads?: BillableLead[]; stripe_invoice_id: string | null; stripe_invoice_number: string | null; hosted_invoice_url: string | null; note: string | null; error: string | null;
};
type Invoice = { id: string; number: string | null; status: string; total: number; created: number; payUrl: string | null; hostedUrl: string | null; pdf: string | null };
type Mode = "test" | "live";
type View = {
  settings: Settings | null; mode: Mode; periods: PeriodRow[]; invoices: Invoice[] | null; invoicesError: string | null; today: string;
  keyState: "test" | "missing" | "refused"; liveKeyState: "live" | "missing" | "refused" | null; refusal: string | null; flags: { scheduler: boolean; charge: boolean };
  schedule: { current: Period | null; lastCompleted: Period | null; firstStarts: string | null; choices: Period[] } | null;
  leadSources: Record<string, string>; defaultLeadSource: string;
};
type PreviewView = {
  label: string; period: Period; count: number; amountCents: number; priceCents: number; leadsHash: string; lines: Array<{ description: string; amountCents: number }>;
  skipped: unknown[]; existing: PeriodRow | null; fake: boolean;
};
type Card = { id: string; label: string; expires: string | null; expired: boolean; isDefault: boolean };
type Customer = { id: string; name: string | null; email: string | null; cards: Card[]; claimedBy?: string[] };
/** The card finder: which Stripe, what it found, the pick. */
type Finder = { mode: Mode; customers: Customer[] | null; pick: { customerId: string; cardId: string } | null; paste: string };
/** Where a message shows: by the part of the panel whose button was pressed. */
type Spot = "top" | "finder" | "charge" | "periods";
type Msg = { text: string; bad: boolean; at: Spot };
/** A confirmation, opened by a button in the charge box or in the list of periods — and shown by that button. */
type Confirm = null | { kind: "charge" } | { kind: "connect" } | { kind: "resume" | "retry"; row: PeriodRow; from: "charge" | "periods" };

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
/** "lead" / "call" / "introduction" — what one charge is for. */
const unitOf = (source: string | null | undefined) => LEAD_SOURCE_UNIT[source as LeadSource] ?? "lead";
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
/** "2026-10-19" → "Oct 19, 2026". */
const day = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—");
/** The product a price and a lead source make — or "custom". */
const productOf = (price: string, source: string) => {
  const cents = Math.round(Number(String(price).replace(/[$,\s]/g, "")) * 100);
  return PAY_PER_LEAD_PRODUCTS.find((p) => p.leadSource === source && p.priceCents === cents)?.id ?? "custom";
};
const TONE: Record<string, string> = { paid: "good", failed: "bad", charged: "warn", draft: "warn", preview: "mute", void: "mute", open: "warn", uncollectible: "bad" };
/** A period's status in a word (the list), and in a sentence (the charge box). Voided in Stripe ≠ nothing to charge. */
const statusWord = (r: Pick<PeriodRow, "status" | "lead_count">) =>
  ({ paid: "paid", failed: "card refused", charged: "charged", draft: "unfinished", preview: "not charged" } as Record<string, string>)[r.status] ?? (r.status === "void" ? (r.lead_count > 0 ? "voided" : "nothing to charge") : r.status);
const periodSentence = (r: Pick<PeriodRow, "status" | "lead_count">) =>
  ({
    paid: "This period is paid",
    failed: "This period was charged, but the card was refused",
    charged: "This period was charged — Stripe hasn't confirmed it yet",
    draft: "This period's charge didn't finish",
  } as Record<string, string>)[r.status] ?? (r.status === "void" ? (r.lead_count > 0 ? "This period's invoice was voided in Stripe" : "This period is closed with nothing to charge") : `This period is ${r.status}`);
/** The card's own words without the expiry the label may carry ("Visa •••• 4242 · exp 08/27" → "Visa •••• 4242"). */
const cardName = (label: string | null | undefined) => (label ?? "the card").replace(/ · exp .*$/, "");
/** Whether a saved card label's expiry ("· exp 08/27") has passed by `today` (YYYY-MM-DD). */
const labelExpired = (label: string | null | undefined, today: string) => {
  const m = / · exp (\d\d)\/(\d\d)$/.exec(label ?? "");
  if (!m) return false;
  const [y, mo] = [2000 + Number(m[2]), Number(m[1])];
  const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  return y < ty || (y === ty && mo < tm);
};
/** Which action shows its message where. */
const SPOT: Record<string, Spot> = { find_cards: "finder", connect_card: "finder", preview: "charge", charge: "charge", retry: "periods", refresh: "periods" };

export type UsageBillingView = View;

/** `initial`: a first answer to show before the route's (a render check uses it). */
export function UsageBillingPanel({ clientId, initial = null }: { clientId: string; initial?: View | null }) {
  const [view, setView] = useState<View | null>(initial);
  // Open by itself for a client that has pay per lead (or on the way back from Checkout); a click away otherwise.
  const [open, setOpen] = useState(initial !== null);
  const [hidden, setHidden] = useState(false);
  const [expired, setExpired] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ price: String(PAY_PER_LEAD_PRODUCTS[0].priceCents / 100), everyDays: "7", anchorDate: "", leadSource: PAY_PER_LEAD_PRODUCTS[0].leadSource as string, enabled: false });
  // "Custom price…" picked: the price and what is counted are typed, even if they happen to match a product.
  const [custom, setCustom] = useState(false);
  const product = custom ? "custom" : productOf(form.price, form.leadSource);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const [periodStart, setPeriodStart] = useState("");
  const [fakeLeads, setFakeLeads] = useState("");
  const [preview, setPreview] = useState<PreviewView | null>(null);
  const [finder, setFinder] = useState<Finder | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [priceOpen, setPriceOpen] = useState(false);
  const confirmedReturn = useRef(false);
  // A preview answer is used only if nothing it depends on changed while it was on its way.
  const previewSeq = useRef(0);
  const confirmBox = useRef<HTMLDivElement | null>(null);

  const say = (text: string, at: Spot = "top", bad = false) => setMsg({ text, at, bad });

  const load = async () => {
    try {
      const res = await fetch(`/api/workspace/clients/billing/usage?clientId=${encodeURIComponent(clientId)}`, { cache: "no-store" });
      if (res.status === 401) { if (view) setExpired(true); else setHidden(true); return; }
      if (res.status === 404) { setHidden(true); return; }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) { say(body?.error ?? `HTTP ${res.status}`, "top", true); return; }
      const v = body as View;
      setView(v);
      if (v.settings) setOpen(true);
      const s = v.settings;
      setForm((f) => s
        ? { price: String(s.price_cents / 100), everyDays: String(s.every_days), anchorDate: s.anchor_date, leadSource: s.lead_source, enabled: s.enabled }
        : { ...f, anchorDate: f.anchorDate || addDays(v.today, -7), leadSource: v.defaultLeadSource });
    } catch (e) {
      say(e instanceof Error ? e.message : "Could not load", "top", true);
    }
  };

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    setMsg(null);
    try {
      const res = await fetch("/api/workspace/clients/billing/usage", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, action, ...extra }),
      });
      if (res.status === 401) { setExpired(true); return null; }
      const body = await res.json().catch(() => null);
      if (!res.ok) { say(body?.error ?? body?.message ?? `HTTP ${res.status}`, SPOT[action] ?? "top", true); return null; }
      return body;
    } catch (e) {
      say(e instanceof Error ? e.message : "Request failed", SPOT[action] ?? "top", true);
      return null;
    } finally {
      setBusy(null);
    }
  };

  // Read once on arrival: a client with pay per lead opens by itself; one without stays a click away.
  useEffect(() => {
    if (new URL(window.location.href).searchParams.has("usage_setup")) setOpen(true);
    void load();
  }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from the Checkout page (test clients): read the card once.
  useEffect(() => {
    if (confirmedReturn.current || !view?.settings || view.mode !== "test" || view.keyState !== "test") return;
    const u = new URL(window.location.href);
    if (u.searchParams.get("usage_setup") !== "done") return;
    confirmedReturn.current = true;
    u.searchParams.delete("usage_setup");
    window.history.replaceState(null, "", u);
    void (async () => {
      const r = await act("confirm_setup");
      if (r) { say(r.saved ? `Card saved: ${r.cardLabel ?? "card"}.` : "The Checkout is not complete yet."); await load(); }
    })();
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  // A confirmation takes the focus as it opens (and Escape closes it), so it is never missed.
  useEffect(() => {
    if (confirm) confirmBox.current?.focus();
  }, [confirm]);

  if (hidden) return null;
  const s = view?.settings ?? null;
  const live = view?.mode === "live";

  if (!open || !view) {
    return (
      <section className="rx-sec cat-billing" data-testid="usage-billing">
        <div className="rb-head">
          <h3><i aria-hidden="true" />Pay per lead<span>{view ? "not set up for this client" : ""}</span></h3>
          {view ? <button type="button" className="rx-btn" onClick={() => setOpen(true)}>Set up pay per lead</button> : null}
        </div>
        {msg ? <div className="ds-field-err" role="alert">{msg.text}</div> : null}
      </section>
    );
  }

  const stripeOk = live ? view.liveKeyState === "live" : view.keyState === "test";
  const liveKeyOk = view.liveKeyState === "live";
  const unit = unitOf(s?.lead_source);
  const rowOf = (start: string) => view.periods.find((p) => p.period_start === start) ?? null;
  // The periods a person can charge: a live client's that have ended; a test client's, the running one too.
  const choices = (view.schedule?.choices ?? []).filter((p) => !live || !p.running);
  const shownStart = choices.some((p) => p.start === periodStart) ? periodStart : (view.schedule?.lastCompleted?.start ?? (live ? "" : view.schedule?.current?.start ?? ""));
  const shownRow = shownStart ? rowOf(shownStart) : null;
  const billed = !!shownRow && shownRow.status !== "preview";
  const previewFits = !!preview && preview.period.start === shownStart;
  // Unsaved changes in the settings form (a test client): Go live uses what is SAVED, so it waits for them.
  const dirty = !!s && !live && (Math.round(Number(String(form.price).replace(/[$,\s]/g, "")) * 100) !== s.price_cents || Number(form.everyDays) !== s.every_days || form.anchorDate !== s.anchor_date || form.leadSource !== s.lead_source || form.enabled !== s.enabled);
  const sample = () => {
    const p = choices.find((c) => c.start === shownStart) ?? view.schedule?.current;
    if (!p) return;
    setFakeLeads([1, 2, 3].map((i) => `Test Lead ${i}, ${addDays(p.start, Math.min(i - 1, 6))}`).join("\n"));
    reset();
  };
  const leadsArg = !live && fakeLeads.trim() ? { fakeLeads } : {};
  function reset() { previewSeq.current += 1; setPreview(null); setConfirm(null); }
  const box = (at: Spot) => (msg && msg.at === at ? (
    msg.bad ? <div className="ds-field-err ub-msg" role="alert">{msg.text}</div> : <p className="rx-hint ub-note" role="status">{msg.text}</p>
  ) : null);
  const keyDown = (e: React.KeyboardEvent) => { if (e.key === "Escape" && !busy) setConfirm(null); };
  /** What the person approves: what they see, and the client as it was when they saw it. */
  const approvedOf = (p: { periodStart: string; count: number; amountCents: number; leadsHash: string }) => ({ ...p, mode: view.mode, paymentMethodId: s?.default_payment_method_id ?? null });

  const doPreview = async () => {
    setConfirm(null);
    const seq = ++previewSeq.current;
    const r = await act("preview", { periodStart: shownStart || undefined, ...leadsArg });
    if (seq !== previewSeq.current) return; // a period, the leads or the card changed meanwhile — this answer is old
    if (r?.preview) setPreview({ ...(r.preview as PreviewView), fake: !!leadsArg.fakeLeads });
  };
  const outcome = (r: { outcome?: string; message?: string; invoice?: { number?: string | null; id: string; total: number; status: string } | null; periods?: unknown }, at: Spot) => {
    // The periods as the server left them, at once — the reload then brings the rest.
    if (Array.isArray(r.periods)) setView((v) => (v ? { ...v, periods: r.periods as PeriodRow[] } : v));
    const bad = r.outcome === "failed";
    say(`${r.message ?? ""}${r.invoice && !bad ? ` Invoice ${r.invoice.number ?? r.invoice.id}: ${money(r.invoice.total)}, ${r.invoice.status}.` : ""}`, at, bad);
  };
  const doCharge = async () => {
    if (!preview) return;
    const r = await act("charge", { periodStart: preview.period.start, ...leadsArg, approved: approvedOf({ periodStart: preview.period.start, count: preview.count, amountCents: preview.amountCents, leadsHash: preview.leadsHash }) });
    setConfirm(null);
    previewSeq.current += 1;
    setPreview(null);
    if (r) outcome(r, "charge");
    await load();
  };
  const doResume = async (row: PeriodRow, at: Spot) => {
    const r = await act("charge", { periodStart: row.period_start, approved: approvedOf({ periodStart: row.period_start, count: row.lead_count, amountCents: row.amount_cents, leadsHash: leadsHash(row.leads ?? []) }) });
    setConfirm(null);
    if (r) outcome(r, at);
    await load();
  };
  const findCards = async (mode: Mode, paste = "") => {
    setConfirm(null);
    const r = await act("find_cards", { mode, ...(paste.trim() ? { customerId: paste.trim() } : {}) });
    if (!r) return;
    const customers = (r.customers ?? []) as Customer[];
    const usable = (c: Customer) => !c.claimedBy?.length;
    const keep = finder?.pick && customers.some((c) => usable(c) && c.id === finder.pick!.customerId && c.cards.some((k) => k.id === finder.pick!.cardId && !k.expired)) ? finder.pick : null;
    // Start from: the card in use (changing a live client's card), the one picked before, or — with ONE usable customer — its default card.
    // Several customers: no pick, so a person chooses the customer on purpose.
    const inUseCustomer = s?.default_payment_method_id ? customers.find((c) => usable(c) && c.cards.some((k) => k.id === s.default_payment_method_id && !k.expired)) : undefined;
    const inUse = inUseCustomer && s?.default_payment_method_id ? { customerId: inUseCustomer.id, cardId: s.default_payment_method_id } : null;
    const only = customers.filter(usable);
    const solo = only.length === 1 ? (only[0].cards.find((k) => k.isDefault && !k.expired) ?? (only[0].cards.filter((k) => !k.expired).length === 1 ? only[0].cards.find((k) => !k.expired)! : null)) : null;
    setFinder({ mode, customers, pick: keep ?? (mode === "live" && live ? inUse : null) ?? (solo ? { customerId: only[0].id, cardId: solo.id } : null), paste });
    if (r.notFound) say(`No Stripe customer ${r.notFound} in ${mode === "live" ? "live" : "test-mode"} Stripe.`, "finder", true);
    else if (mode === "live" && r.claimsChecked === false) say("Couldn't check which client each customer belongs to — going live will check again.", "finder", true);
  };
  const pickedCustomer = finder?.pick ? finder.customers?.find((c) => c.id === finder.pick!.customerId) ?? null : null;
  const pickedCard = finder?.pick ? pickedCustomer?.cards.find((k) => k.id === finder.pick!.cardId) ?? null : null;
  const goingLive = finder?.mode === "live" && !live;
  const doConnect = async () => {
    if (!finder?.pick) return;
    const r = await act("connect_card", { mode: finder.mode, customerId: finder.pick.customerId, paymentMethodId: finder.pick.cardId, ...(goingLive ? { goLive: true } : {}) });
    setConfirm(null);
    if (r) {
      // The card (and, going live, the mode) as saved, at once: a confirmation opened next must name THIS card.
      if (r.settings) setView((v) => (v ? { ...v, settings: r.settings as Settings, mode: (r.mode as Mode) ?? v.mode } : v));
      setFinder(null);
      previewSeq.current += 1;
      setPreview(null);
      setPeriodStart("");
      say(goingLive ? `This client is now LIVE: ${productLabel((s?.lead_source ?? "handoffs") as LeadSource, s?.price_cents ?? 0)}, charged to ${cardName(r.settings?.card_label)} when someone here approves each period.` : `Card connected: ${cardName(r.settings?.card_label)}.`);
      await load();
    }
  };
  const doRetry = async (row: PeriodRow, at: Spot) => {
    const r = await act("retry", { periodStart: row.period_start, approved: { amountCents: row.amount_cents, mode: view.mode, paymentMethodId: s?.default_payment_method_id ?? null } });
    setConfirm(null);
    if (r) outcome(r, at);
    await load();
  };
  const firstPeriod = s ? { start: s.anchor_date, end: addDays(s.anchor_date, s.every_days) } : null;
  /** The "try again" and "retry" confirmations, shown by the button that opened them. */
  const rowConfirm = (from: "charge" | "periods") => {
    if (!s || !confirm || (confirm.kind !== "resume" && confirm.kind !== "retry") || confirm.from !== from) return null;
    const row = confirm.row;
    const resume = confirm.kind === "resume";
    const what = periodLabel({ start: row.period_start, end: row.period_end });
    return (
      <div className={`ub-confirm${live ? " live" : ""}`} role="alertdialog" aria-label={resume ? "Confirm trying again" : "Confirm the retry"} aria-describedby={`ub-row-${clientId}`} tabIndex={-1} ref={confirmBox} onKeyDown={keyDown}>
        {resume ? (
          <p id={`ub-row-${clientId}`}><b>Try the charge of {money(row.amount_cents)} for {what} again</b> on {cardName(s.card_label)}? It picks up where it stopped, with the same {plural(row.lead_count, unit)} — never charging twice.{live ? " A real charge." : " Stripe test mode."}</p>
        ) : (
          <p id={`ub-row-${clientId}`}><b>Retry {money(row.amount_cents)} for {what}</b> on {cardName(s.card_label)}?{live ? " A real charge." : " Stripe test mode."} If the client has a new card, change the card first.</p>
        )}
        <div className="rb-tools ub-tight">
          <button type="button" className={`rx-btn solid${live ? " rb-danger" : ""}`} disabled={!!busy} onClick={() => void (resume ? doResume(row, from) : doRetry(row, from))}>
            {busy === "charge" || busy === "retry" ? "Charging…" : resume ? "Yes, try again" : `Yes, retry ${money(row.amount_cents)}`}
          </button>
          <button type="button" className="rx-btn" disabled={!!busy} onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      </div>
    );
  };

  /* ------------------------------------------------------------ the card finder --- */
  const finderBox = finder ? (
    <div className="ub-box" data-testid="usage-finder">
      <div className="ub-box-h">
        <b>{finder.mode === "live" ? (live ? "Change the card" : "The client's card on file in Stripe") : "A test card already on file (Stripe test mode)"}</b>
        <button type="button" className="rb-chip" disabled={!!busy} onClick={() => { setFinder(null); setConfirm(null); setMsg(null); }}>Close</button>
      </div>
      {finder.customers === null ? null : finder.customers.length === 0 ? (
        <p className="rx-hint ub-tight">No Stripe customer {finder.mode === "live" ? "is linked to this client yet" : "was made for this client in test mode"}. Paste the customer&apos;s ID from Stripe below.</p>
      ) : (
        <div className="ub-customers" role="radiogroup" aria-label="Cards on file">
          {finder.customers.length > 1 ? <p className="rx-hint ub-tight">Several Stripe customers — pick the card of the one that is this client.</p> : null}
          {finder.customers.map((c) => {
            const claimed = !!c.claimedBy?.length;
            return (
              <fieldset key={c.id} className="ub-customer" disabled={claimed}>
                <legend><b>{c.name ?? "Unnamed customer"}</b>{c.email ? <span>{c.email}</span> : null}<code>{c.id}</code></legend>
                {claimed ? <p className="ds-field-err ub-tight">Counted for {c.claimedBy!.join(", ")} on the Billing tab — can&apos;t be used for this client.</p> : null}
                {c.cards.length === 0 ? <p className="rx-hint ub-tight">No card on file on this customer.</p> : c.cards.map((k) => (
                  <label key={k.id} className={`ub-card${k.expired || claimed ? " off" : ""}`}>
                    <input type="radio" name={`ub-card-${clientId}`} disabled={k.expired || claimed} checked={finder.pick?.cardId === k.id && finder.pick.customerId === c.id}
                      onChange={() => { setFinder({ ...finder, pick: { customerId: c.id, cardId: k.id } }); setConfirm(null); }} />
                    <span>{k.label}</span>
                    {k.expires ? <small>exp {k.expires}</small> : null}
                    {s?.default_payment_method_id === k.id && s.stripe_customer_id === c.id ? <em className="rb-pill good">in use</em> : null}
                    {k.isDefault ? <em className="rb-pill mute">Stripe default</em> : null}
                    {k.expired ? <em className="rb-pill bad">expired</em> : null}
                  </label>
                ))}
              </fieldset>
            );
          })}
        </div>
      )}
      <div className="rb-tools ub-tight">
        <label className="rb-field ub-paste"><span>Not listed? Stripe customer ID</span>
          <input className="ds-input" placeholder="cus_…" value={finder.paste} onChange={(e) => setFinder({ ...finder, paste: e.target.value })} />
        </label>
        <button type="button" className="rx-btn ub-self-end" disabled={!!busy || !/^cus_[A-Za-z0-9]{6,}$/.test(finder.paste.trim())} onClick={() => void findCards(finder.mode, finder.paste)}>
          {busy === "find_cards" ? "Looking…" : "Look up"}
        </button>
        <span className="sp" />
        <button type="button" className={`rx-btn solid ub-self-end ub-wrap${goingLive ? " rb-danger" : ""}`} disabled={!!busy || !pickedCard || (goingLive && dirty)} onClick={() => setConfirm({ kind: "connect" })}>
          {!pickedCard ? "Pick a card" : goingLive ? `Go live with ${pickedCard.label}` : `Use ${pickedCard.label}`}
        </button>
      </div>
      {goingLive && dirty ? <p className="ds-field-err ub-tight">Save your changes above first — going live uses the saved price and schedule.</p> : null}
      {box("finder")}
      {confirm?.kind === "connect" && pickedCard && pickedCustomer ? (
        <div className={`ub-confirm${goingLive ? " live" : ""}`} role="alertdialog" aria-label="Confirm the card" aria-describedby={`ub-connect-${clientId}`} tabIndex={-1} ref={confirmBox} onKeyDown={keyDown}>
          {goingLive ? (
            <p id={`ub-connect-${clientId}`}><b>Make this client live?</b> From now on its pay per lead is real: {productLabel((s?.lead_source ?? "handoffs") as LeadSource, s?.price_cents ?? 0)}, every {s?.every_days} days from {day(s?.anchor_date)}, charged to {pickedCard.label} of Stripe customer {pickedCustomer.name ?? pickedCustomer.id}{pickedCustomer.email ? ` (${pickedCustomer.email})` : ""} — only when someone here approves each period&apos;s amount. The schedule can&apos;t change after this, and every period since {day(s?.anchor_date)} that has ended can be charged. Nothing is charged now.</p>
          ) : (
            <p id={`ub-connect-${clientId}`}><b>Use {pickedCard.label}{pickedCard.expires ? ` (exp ${pickedCard.expires})` : ""}</b> of {pickedCustomer.name ?? pickedCustomer.id} for this client&apos;s pay per lead from now on?</p>
          )}
          <div className="rb-tools ub-tight">
            <button type="button" className={`rx-btn solid${goingLive ? " rb-danger" : ""}`} disabled={!!busy || (goingLive && dirty)} onClick={() => void doConnect()}>
              {busy === "connect_card" ? "Connecting…" : goingLive ? "Yes, go live" : "Yes, use this card"}
            </button>
            <button type="button" className="rx-btn" disabled={!!busy} onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <section className="rx-sec cat-billing" data-testid="usage-billing" data-mode={live ? "live" : "test"}>
      <div className="rb-head">
        <h3><i aria-hidden="true" />Pay per lead<span>{!s ? "not set up for this client" : live ? "live — charged to the client's card when approved here" : "test mode — no real card is charged"}</span></h3>
        {s ? <span className={`rb-pill ${live ? "ub-live" : "warn"}`}>{live ? "LIVE" : "STRIPE TEST MODE"}</span> : null}
      </div>
      {expired ? <div className="ds-field-err ub-msg" role="alert">Your session has expired — reload the page and sign in again. Nothing more was sent.</div> : null}
      {!live && s ? (
        <p className="rx-hint ub-tight">
          Try it end to end with Stripe&apos;s test card (4242 4242 4242 4242): nothing in test mode can charge a real card. When the client is ready, <b>Go live</b> connects the card they have on file in Stripe.
        </p>
      ) : null}
      {s && !stripeOk ? (
        <div className="rx-bill-fail" role="alert" style={{ margin: "8px 0" }}>
          {live ? (
            <>
              <b>{view.liveKeyState === "refused" ? "The OS's Stripe key is not a live key" : "The OS has no Stripe key"}</b>
              <span>This live client can&apos;t be charged until it&apos;s fixed. Nothing is sent to Stripe meanwhile.</span>
            </>
          ) : (
            <>
              <b>{view.keyState === "missing" ? "No Stripe test key" : "Stripe key refused"}</b>
              <span>{view.keyState === "missing" ? "OS_USAGE_BILLING_STRIPE_KEY is not set on this server — saving and previews work; the test card and test charges are off." : "OS_USAGE_BILLING_STRIPE_KEY is not a Stripe TEST key, so every test action is refused."}</span>
            </>
          )}
        </div>
      ) : null}
      {box("top")}

      {/* ---------------------------------------------------- settings (test, or not set up) */}
      {!live ? (
        <>
          {/* The product first — the same ones offered when a client is onboarded (a saved one no longer offered still shows) — or a custom price. */}
          <div className="rb-tools ub-settings">
            <label className="rb-field ub-product"><span>Product</span>
              <select className="ds-input" value={product} onChange={(e) => {
                const p = PAY_PER_LEAD_PRODUCTS.find((x) => x.id === e.target.value);
                setCustom(!p);
                if (p) setForm({ ...form, price: String(p.priceCents / 100), leadSource: p.leadSource });
              }}>
                {PAY_PER_LEAD_PRODUCTS.filter((p) => p.offered || p.id === product).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
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
            <button type="button" className="rx-btn solid" disabled={!!busy || (!!s && !dirty)} onClick={async () => {
              const r = await act("save", { price: form.price, everyDays: Number(form.everyDays), anchorDate: form.anchorDate, leadSource: form.leadSource, enabled: form.enabled });
              if (r) { say(s ? "Saved." : "Saved — this client is set up for pay per lead in test mode."); setPeriodStart(""); reset(); await load(); }
            }}>{busy === "save" ? "Saving…" : s ? "Save" : "Save (test mode)"}</button>
          </div>
        </>
      ) : null}
      {view.refusal && s ? <p className="ds-field-err">{view.refusal}</p> : null}

      {s && !view.refusal ? (
        <>
          {/* ------------------------------------------------------------- summary */}
          <div className="rb-grid ub-grid" data-testid="usage-summary">
            <div><small>Product</small><b>{productLabel(s.lead_source as LeadSource, s.price_cents)}</b><span>every {s.every_days} days, from {day(s.anchor_date)}</span></div>
            <div><small>Card</small><b>{s.card_label ? cardName(s.card_label) : "None yet"}</b>
              <span className={labelExpired(s.card_label, view.today) ? "ub-bad" : undefined}>
                {labelExpired(s.card_label, view.today) ? "expired — change the card before the next charge" : s.card_label ? (live ? `on file in Stripe${/ · exp /.test(s.card_label) ? ` · ${s.card_label.replace(/^.* · /, "")}` : ""}` : "a Stripe test card") : live ? "" : "no test card yet"}
              </span>
            </div>
            <div><small>Current period</small><b>{view.schedule?.current?.label ?? (firstPeriod ? periodLabel(firstPeriod) : "—")}</b><span>{view.schedule?.firstStarts ? `starts ${day(view.schedule.firstStarts)}` : view.schedule?.current ? `ready to charge from ${day(view.schedule.current.end)}` : ""}</span></div>
            {live ? (
              <div><small>Charges</small><b>Approved here</b><span>each period, once it ends — never automatically</span></div>
            ) : (
              <div><small>Scheduled run</small><b>{view.flags.scheduler ? (view.flags.charge ? "Charging test clients" : "Previews only") : "Off"}</b><span>{s.enabled ? "this client is in it" : "this client is not in it"}</span></div>
            )}
          </div>

          {/* ------------------------------------------------------- go live (test) */}
          {!live && finder?.mode !== "live" ? (
            <div className="ub-box ub-golive">
              <div className="ub-box-h"><b>Go live — bill this client for real</b></div>
              <p className="rx-hint ub-tight">Connect the card the client already has on file in Stripe. From then on each period is charged to it when someone here approves the amount. Going live charges nothing.</p>
              {!liveKeyOk ? <p className="ds-field-err ub-tight">{view.liveKeyState === "refused" ? "The OS's Stripe key is not a live key" : "The OS has no Stripe key"} — going live is off until it&apos;s fixed.</p> : null}
              <div className="rb-tools ub-tight">
                <button type="button" className="rx-btn" disabled={!!busy || !liveKeyOk} onClick={() => void findCards("live")}>{busy === "find_cards" ? "Looking in Stripe…" : "Find their card on file"}</button>
              </div>
              {finder === null ? box("finder") : null}
            </div>
          ) : null}
          {finderBox}

          {/* -------------------------------------------- test tools: the test card */}
          {!live ? (
            <div className="rb-tools">
              <button type="button" className="rx-btn" disabled={!!busy || !stripeOk} onClick={async () => {
                const r = await act("setup_link");
                if (r?.url) setSetupUrl(r.url);
              }}>{busy === "setup_link" ? "Making link…" : s.card_label ? "New test card-setup link" : "Get test card-setup link"}</button>
              <button type="button" className="rx-btn" disabled={!!busy || !stripeOk || !s.setup_session_id} title={!s.setup_session_id ? "Make a card-setup link first" : undefined} onClick={async () => {
                const r = await act("confirm_setup");
                if (r) { say(r.saved ? `Card saved: ${r.cardLabel ?? "card"}.` : `The Checkout is ${r.status ?? "not complete"} — finish it, then check again.`); await load(); }
              }}>{busy === "confirm_setup" ? "Checking…" : "Check test card"}</button>
              <button type="button" className="rx-btn" disabled={!!busy || !stripeOk} onClick={() => void findCards("test")}>Use a test card on file</button>
              {setupUrl ? (
                <>
                  <input className="ds-input" readOnly value={setupUrl} style={{ flex: 1, minWidth: 200 }} onFocus={(e) => e.currentTarget.select()} aria-label="Card-setup link" />
                  <a className="rx-btn" href={setupUrl} target="_blank" rel="noreferrer">Open ↗</a>
                </>
              ) : null}
            </div>
          ) : !finder ? (
            <div className="rb-tools">
              <button type="button" className="rx-btn" disabled={!!busy || !stripeOk} onClick={() => void findCards("live")}>Change card</button>
              <button type="button" className="rx-btn" onClick={() => setPriceOpen((o) => !o)} aria-expanded={priceOpen}>Change price</button>
            </div>
          ) : null}
          {live && priceOpen ? (
            <div className="rb-tools ub-settings">
              <label className="rb-field ub-price"><span>Price per {unit} ($)</span>
                <input className="ds-input" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
              </label>
              <span className="rx-hint ub-tight ub-self-end">Every {s.every_days} days from {day(s.anchor_date)} — a live client&apos;s schedule stays as it is. Periods not charged yet use the new price.</span>
              <span className="sp" />
              <button type="button" className="rx-btn solid ub-self-end" disabled={!!busy} onClick={async () => {
                const r = await act("save", { price: form.price, everyDays: s.every_days, anchorDate: s.anchor_date, leadSource: s.lead_source, enabled: s.enabled });
                if (r) { say("Price saved — periods not charged yet use it."); setPriceOpen(false); reset(); await load(); }
              }}>{busy === "save" ? "Saving…" : "Save price"}</button>
            </div>
          ) : null}

          {/* ------------------------------------------------------- charge a period */}
          <div className="ub-box" data-testid="usage-charge">
            <div className="ub-box-h"><b>{live ? "Charge a period" : "Preview and test charge"}</b></div>
            {choices.length === 0 ? (
              <p className="rx-hint ub-tight">
                {firstPeriod ? `The first period runs ${periodLabel(firstPeriod)} — it can be charged from ${day(firstPeriod.end)}.` : ""}
              </p>
            ) : (
              <>
                <div className="rb-tools ub-tight ub-charge-tools">
                  <label className="rb-field"><span>Period</span>
                    <select className="ds-input ub-period" value={shownStart} onChange={(e) => { setPeriodStart(e.target.value); reset(); setMsg(null); }}>
                      {choices.map((p) => {
                        const row = rowOf(p.start);
                        const tag = p.running ? " (still running — test only)" : row && row.status !== "preview" ? ` — ${statusWord(row)}` : "";
                        return <option key={p.start} value={p.start}>{p.label}{tag}</option>;
                      })}
                    </select>
                  </label>
                  {!live ? (
                    <div className="rb-field ub-fake">
                      <span>Fake leads (optional) — one per line: Name, YYYY-MM-DD <button type="button" className="rb-chip" onClick={sample}>Fill 3 samples</button></span>
                      <textarea className="ds-input" rows={3} aria-label="Fake leads, one per line: Name, YYYY-MM-DD" value={fakeLeads} placeholder="Empty: the real leads (conversations marked Interested)" onChange={(e) => { setFakeLeads(e.target.value); reset(); }} />
                    </div>
                  ) : null}
                </div>
                {billed && shownRow ? (
                  <>
                    <p className="rx-hint ub-tight">{periodSentence(shownRow)}: {plural(shownRow.lead_count, unit)}, {money(shownRow.amount_cents)}.</p>
                    {shownRow.status === "draft" ? (
                      <div className="rb-tools ub-tight">
                        <button type="button" className={`rx-btn solid${live ? " rb-danger" : ""}`} disabled={!!busy || !stripeOk || !s.default_payment_method_id} onClick={() => setConfirm({ kind: "resume", row: shownRow, from: "charge" })}>Try the charge again</button>
                      </div>
                    ) : shownRow.status === "failed" ? (
                      <div className="rb-tools ub-tight">
                        <button type="button" className={`rx-btn solid ub-wrap${live ? " rb-danger" : ""}`} disabled={!!busy || !stripeOk || !s.default_payment_method_id} onClick={() => setConfirm({ kind: "retry", row: shownRow, from: "charge" })}>{`Retry ${money(shownRow.amount_cents)} on ${cardName(s.card_label)}`}</button>
                        {shownRow.hosted_invoice_url ? <a className="rx-btn" href={shownRow.hosted_invoice_url} target="_blank" rel="noreferrer">Pay link ↗</a> : null}
                      </div>
                    ) : null}
                    {rowConfirm("charge")}
                  </>
                ) : (
                  <div className="rb-tools ub-tight">
                    <button type="button" className="rx-btn" disabled={!!busy || !shownStart} onClick={() => void doPreview()}>{busy === "preview" ? "Reading leads…" : previewFits ? "Preview again" : "Preview"}</button>
                    {previewFits && preview!.count > 0 ? (
                      <button type="button" className={`rx-btn solid ub-wrap${live ? " rb-danger" : ""}`} disabled={!!busy || !stripeOk || !s.default_payment_method_id}
                        title={!s.default_payment_method_id ? (live ? "Connect a card first" : "Save a test card first") : undefined}
                        onClick={() => setConfirm({ kind: "charge" })}>
                        {`Charge ${money(preview!.amountCents)} to ${s.card_label ? cardName(s.card_label) : "the card"}${live ? "" : " (test)"}`}
                      </button>
                    ) : null}
                    {previewFits && preview!.count === 0 ? (
                      <button type="button" className="rx-btn" disabled={!!busy || !stripeOk || !s.default_payment_method_id} title={!s.default_payment_method_id ? "Connect a card first" : undefined} onClick={() => setConfirm({ kind: "charge" })}>Close it — nothing to charge</button>
                    ) : null}
                  </div>
                )}
                {!billed && confirm?.kind === "charge" && previewFits ? (
                  <div className={`ub-confirm${live && preview!.count > 0 ? " live" : ""}`} role="alertdialog" aria-label="Confirm the charge" aria-describedby={`ub-charge-${clientId}`} tabIndex={-1} ref={confirmBox} onKeyDown={keyDown}>
                    {preview!.count > 0 ? (
                      <p id={`ub-charge-${clientId}`}><b>Charge {money(preview!.amountCents)} to {cardName(s.card_label)}?</b> {plural(preview!.count, unit)} × {money(preview!.priceCents)}, {preview!.label}.{" "}
                        {live ? "This is a real charge to the client's card. A refund, if ever needed, is on this Billing tab." : "Stripe test mode — no real money moves."}</p>
                    ) : (
                      <p id={`ub-charge-${clientId}`}><b>Close {preview!.label} with nothing to charge?</b> No {unit} counted in it; nothing is sent to Stripe. It is closed for good — a {unit} marked later for these dates won&apos;t be billed.</p>
                    )}
                    <div className="rb-tools ub-tight">
                      <button type="button" className={`rx-btn solid${live && preview!.count > 0 ? " rb-danger" : ""}`} disabled={!!busy} onClick={() => void doCharge()}>
                        {busy === "charge" ? (preview!.count > 0 ? "Charging…" : "Closing…") : preview!.count > 0 ? `Yes, charge ${money(preview!.amountCents)}` : "Yes, close it"}
                      </button>
                      <button type="button" className="rx-btn" disabled={!!busy} onClick={() => setConfirm(null)}>Cancel</button>
                    </div>
                  </div>
                ) : null}
                {box("charge")}
                {previewFits && !billed ? (
                  <div className="rb-scroll" data-testid="usage-preview">
                    <p className="rx-hint ub-tight">
                      {preview!.label}: <b>{plural(preview!.count, unit)} × {money(preview!.priceCents)} = {money(preview!.amountCents)}</b>
                      {preview!.fake ? " · typed-in test leads" : ""}
                      {preview!.skipped.length ? ` · ${preview!.skipped.length} not counted (already billed, or the same agent twice)` : ""}
                    </p>
                    {preview!.lines.length ? (
                      <table className="rb-table">
                        <thead><tr><th>Invoice line</th><th className="num">Amount</th></tr></thead>
                        <tbody>{preview!.lines.map((l, i) => <tr key={i}><td>{l.description}</td><td className="num">{money(l.amountCents)}</td></tr>)}</tbody>
                      </table>
                    ) : <p className="rx-hint ub-tight">No {unit} in this period — nothing would be charged.</p>}
                  </div>
                ) : null}
              </>
            )}
          </div>

          {/* ------------------------------------------------------------ the periods */}
          {view.periods.length ? (
            <div style={{ marginTop: 12 }}>
              <div className="rb-scroll">
                <table className="rb-table" data-testid="usage-periods">
                  <thead><tr><th>Period</th><th className="num">{unit[0].toUpperCase() + unit.slice(1)}s</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {view.periods.map((p) => (
                      <tr key={p.id}>
                        <td>{periodLabel({ start: p.period_start, end: p.period_end })}{p.error || p.note ? <small>{p.error ?? p.note}</small> : null}</td>
                        <td className="num">{p.lead_count}</td>
                        <td className="num">{money(p.amount_cents)}</td>
                        <td><span className={`rb-pill ${TONE[p.status] ?? "mute"}`}>{statusWord(p)}</span></td>
                        <td className="rb-links">
                          {p.hosted_invoice_url ? <a href={p.hosted_invoice_url} target="_blank" rel="noreferrer">{p.status === "failed" ? "Pay link ↗" : "Invoice ↗"}</a> : null}
                          {p.status === "failed" && stripeOk ? (
                            <button type="button" className="rb-chip ub-gap" disabled={!!busy || !s.default_payment_method_id} onClick={() => setConfirm({ kind: "retry", row: p, from: "periods" })}>Retry charge</button>
                          ) : null}
                          {p.status === "draft" && stripeOk ? (
                            <button type="button" className="rb-chip ub-gap" disabled={!!busy || !s.default_payment_method_id} onClick={() => setConfirm({ kind: "resume", row: p, from: "periods" })}>Try again</button>
                          ) : null}
                          {(p.status === "charged" || p.status === "failed") && stripeOk ? (
                            <button type="button" className="rb-chip ub-gap" disabled={!!busy} onClick={async () => { setConfirm(null); if (await act("refresh", { periodStart: p.period_start })) await load(); }}>Refresh</button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rowConfirm("periods")}
              {box("periods")}
            </div>
          ) : (
            box("periods")
          )}

          {/* --------------------------------------------- Stripe's own record of them */}
          {view.invoices?.length ? (
            <div className="rb-scroll" style={{ marginTop: 12 }}>
              <table className="rb-table">
                <thead><tr><th>{live ? "Pay-per-lead invoice" : "Test-mode invoice"}</th><th>Date</th><th className="num">Total</th><th>Status</th><th /></tr></thead>
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
          ) : view.invoicesError ? <p className="ds-field-err">Stripe could not be read: {view.invoicesError}</p> : null}
        </>
      ) : null}
    </section>
  );
}
