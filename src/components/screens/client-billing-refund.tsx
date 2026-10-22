"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { dollarsToCents, givenBack, REFUND_REASONS, type RefundReason } from "@/lib/clients/billing-refund";
import type { BillingInvoiceRow } from "@/lib/clients/billing-model";

/*
 * Refund an invoice (Eddy's plan, approved 22 Oct): full or partial, a reason,
 * an optional note, whether Stripe emails the client the credit note (off
 * unless ticked). Then a confirmation with Stripe's own preview before anything
 * happens. The route is /api/workspace/clients/billing/refund.
 *
 * When Stripe's answer is lost after the refund was sent, the dialog says it
 * may have gone through, re-reads the tab, and offers only Close or the SAME
 * refund again (same key — the route answers with the refund already made).
 * There is no Back to a new amount until the person has looked.
 */

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

type Step = { at: "form" } | { at: "confirm"; key: string; cents: number; stripeCents: number } | { at: "done"; cents: number; creditNote: string };
type Answer = { ok?: boolean; error?: string; uncertain?: boolean; preview?: { amount: number }; refund?: { creditNote: string; amount: number } };

const LOST = "Stripe didn't confirm the refund — it may still have gone through. Check the billing history before anything else. Pressing Refund again here is safe: it will not refund twice.";


export function RefundDialog({ clientId, invoice, onClose, onRefunded }: {
  clientId: string;
  invoice: BillingInvoiceRow;
  onClose: () => void;
  onRefunded: () => void;
}) {
  const left = invoice.refundable;
  const [whole, setWhole] = useState(true);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<RefundReason | "">("");
  const [note, setNote] = useState("");
  const [emailClient, setEmailClient] = useState(false);
  const [step, setStep] = useState<Step>({ at: "form" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Sent, no clear answer: only Close or the same refund again. */
  const [lost, setLost] = useState(false);
  /* Each step's first thing gets the focus, so the keyboard never lands on the page behind. */
  const stepFocus = useRef<HTMLElement | null>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    stepFocus.current?.focus();
  }, [step.at]);
  /*
   * ModalDialog re-runs its focus effect whenever onClose changes; this
   * component re-renders on every keystroke, so its onClose must be stable or
   * focus jumps back to the first field. Escape does nothing mid-request.
   */
  const latest = useRef({ busy, onClose });
  useEffect(() => { latest.current = { busy, onClose }; });
  const close = useCallback(() => { if (!latest.current.busy) latest.current.onClose(); }, []);

  const name = invoice.number ?? invoice.id;
  const cents = whole ? Math.round(left * 100) : dollarsToCents(amount);
  const amountError = whole ? null
    : !amount.trim() ? null
    : cents === null || cents <= 0 ? "Enter an amount, like 250 or 250.50."
    : cents > Math.round(left * 100) ? `At most ${money(left)} can be refunded on this invoice.`
    : null;
  const ready = !!reason && cents !== null && cents > 0 && !amountError;

  /** null: no answer reached the browser at all. */
  const send = async (preview: boolean, key: string, c: number): Promise<{ status: number; body: Answer } | null> => {
    try {
      const res = await fetch("/api/workspace/clients/billing/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, invoiceId: invoice.id, amount: c, reason, note: note.trim(), emailClient, key, preview }),
      });
      return { status: res.status, body: ((await res.json().catch(() => null)) as Answer | null) ?? {} };
    } catch {
      return null;
    }
  };
  const failure = (out: { status: number; body: Answer }) =>
    out.body.error ?? (out.status === 404 ? "Refunds are not available to you." : `Something went wrong (HTTP ${out.status}).`);

  const review = async () => {
    if (!ready || cents === null) return;
    setBusy(true);
    setError(null);
    // One key per confirmation: a double click or a retry of the same refund refunds once.
    const key = crypto.randomUUID();
    const out = await send(true, key, cents);
    setBusy(false);
    if (out?.body.ok && out.body.preview) setStep({ at: "confirm", key, cents, stripeCents: Math.round(out.body.preview.amount * 100) });
    else setError(out ? failure(out) : "The OS could not be reached. Nothing was refunded — try again.");
  };

  const confirm = async () => {
    if (step.at !== "confirm") return;
    setBusy(true);
    setError(null);
    const out = await send(false, step.key, step.cents);
    setBusy(false);
    if (out?.body.ok) {
      setLost(false);
      setStep({ at: "done", cents: Math.round((out.body.refund?.amount ?? step.cents / 100) * 100), creditNote: out.body.refund?.creditNote ?? "" });
      onRefunded();
    } else if (!out || out.body.uncertain) {
      setLost(true);
      setError(LOST);
      onRefunded();
    } else setError(failure(out));
  };

  return (
    <ModalDialog open onClose={close} width={520} label={`Refund invoice ${name}`}>
      <div className="rb-dlg" data-testid="rb-refund">
        <header>
          <h2>Refund invoice {name}</h2>
          <p>Paid {money(invoice.paid)}{invoice.card ? ` with ${invoice.card}` : ""}{givenBack(invoice) ? ` · ${givenBack(invoice)} already` : ""}</p>
        </header>

        {step.at === "form" ? (
          <div className="rb-dlg-body">
            <fieldset>
              <legend>Amount</legend>
              <label className="rb-opt">
                <input type="radio" name="rb-amount" checked={whole} onChange={() => setWhole(true)} ref={(el) => { if (step.at === "form") stepFocus.current = el; }} />
                <span>{left < invoice.paid ? "Everything left" : "Full refund"} <b>{money(left)}</b></span>
              </label>
              <label className="rb-opt">
                <input type="radio" name="rb-amount" checked={!whole} onChange={() => setWhole(false)} />
                <span>Part of it</span>
              </label>
              {!whole ? (
                <div className="rb-amt">
                  <span aria-hidden="true">$</span>
                  <input id="rb-refund-amount" className="ds-input" inputMode="decimal" autoFocus placeholder="0.00" aria-label="Amount to refund, in dollars"
                    value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,$]/g, ""))} aria-invalid={!!amountError} />
                  <small>of {money(left)}</small>
                </div>
              ) : null}
              {amountError ? <div className="ds-field-err" role="alert">{amountError}</div> : null}
            </fieldset>

            <label className="rb-field" htmlFor="rb-refund-reason">
              <span>Reason</span>
              <select id="rb-refund-reason" className="ds-input" value={reason} onChange={(e) => setReason(e.target.value as RefundReason)}>
                <option value="" disabled>Choose a reason</option>
                {(Object.keys(REFUND_REASONS) as RefundReason[]).map((k) => <option key={k} value={k}>{REFUND_REASONS[k]}</option>)}
              </select>
            </label>

            <label className="rb-field" htmlFor="rb-refund-note">
              <span>Note <em>optional · printed on the credit note</em></span>
              <textarea id="rb-refund-note" className="ds-input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>

            <label className="rb-check">
              <input type="checkbox" checked={emailClient} onChange={(e) => setEmailClient(e.target.checked)} />
              <span>Email the credit note to the client</span>
            </label>

            {error ? <div className="ds-field-err" role="alert">{error}</div> : null}
            <footer>
              <button type="button" className="rx-btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="rx-btn solid" onClick={() => void review()} disabled={!ready || busy}>{busy ? "Checking with Stripe…" : "Review refund"}</button>
            </footer>
          </div>
        ) : step.at === "confirm" ? (
          <div className="rb-dlg-body">
            <div className="rb-sum" data-testid="rb-refund-confirm" tabIndex={-1} ref={(el) => { stepFocus.current = el; }}>
              <b>Refund {money(step.stripeCents / 100)} to {invoice.card ?? "the original payment method"}?</b>
              <dl>
                <dt>Stripe&rsquo;s preview</dt><dd>a credit note of {money(step.stripeCents / 100)} on this invoice</dd>
                <dt>Invoice</dt><dd>{name}</dd>
                <dt>Reason</dt><dd>{reason ? REFUND_REASONS[reason] : "—"}</dd>
                {note.trim() ? <><dt>Note</dt><dd>{note.trim()}</dd></> : null}
                <dt>Client email</dt><dd>{emailClient ? "Stripe emails them the credit note" : "Not emailed"}</dd>
              </dl>
              <p>Stripe makes a credit note on the invoice and returns the money to the card or account it was paid with. It usually shows in 5–10 business days. Stripe keeps its processing fee. This cannot be undone.</p>
            </div>
            {step.stripeCents !== step.cents ? (
              <div className="ds-field-err" role="alert">Stripe&rsquo;s preview is {money(step.stripeCents / 100)}, not the {money(step.cents / 100)} entered. Go back and check the amount.</div>
            ) : null}
            {error ? <div className="ds-field-err" role="alert">{error}</div> : null}
            <footer>
              {lost
                ? <button type="button" className="rx-btn" onClick={onClose} disabled={busy}>Close and check the history</button>
                : <button type="button" className="rx-btn" onClick={() => { setStep({ at: "form" }); setError(null); }} disabled={busy}>Back</button>}
              {step.stripeCents === step.cents ? (
                <button type="button" className="rx-btn solid rb-danger" onClick={() => void confirm()} disabled={busy}>
                  {busy ? "Refunding…" : lost ? `Refund ${money(step.cents / 100)} — try again` : `Refund ${money(step.cents / 100)}`}
                </button>
              ) : null}
            </footer>
          </div>
        ) : (
          <div className="rb-dlg-body">
            <div className="rb-sum ok" role="status">
              <b>Refunded {money(step.cents / 100)}</b>
              <p>{step.creditNote ? `Credit note ${step.creditNote}. ` : ""}It shows in the billing history once Stripe is read again — that is happening now.</p>
            </div>
            <footer>
              <button type="button" className="rx-btn solid" onClick={onClose} ref={(el) => { if (step.at === "done") stepFocus.current = el; }}>Close</button>
            </footer>
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
