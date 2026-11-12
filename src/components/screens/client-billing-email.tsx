"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { cleanEmail, sameEmail } from "@/lib/clients/billing-email";
import type { ClaimSource } from "@/lib/clients/billing-model";

/*
 * Change where Stripe sends a customer's invoices, receipts and payment reminders: the customer's one email address
 * (12 Nov; the Billing tab's people only; the plan is in billing-email.ts). Two steps: type the new address, then
 * confirm it, the old and new side by side.
 *
 * THE CUSTOMER AND ITS ADDRESS ARE FIXED WHEN THE DIALOG OPENS: the request names that address as the one being
 * replaced, and the OS refuses it, sending nothing, if Stripe has another by then. The record is read again only when
 * the dialog closes.
 */

type Answer = { ok?: boolean; error?: string; uncertain?: boolean; done?: boolean; message?: string; email?: string | null };
type Step = { at: "edit" } | { at: "confirm"; to: string } | { at: "done"; title: string; text: string };

const LOST = "Stripe didn't confirm, so the change may still have gone through. Close this to see the address Stripe has now. Pressing the button again here is safe: it sets the same address.";
/** Answers that mean this request can't work as it stands (refused, not found, not allowed): close and look again. */
const FINAL = new Set([400, 403, 404, 409]);

export function InvoiceEmailDialog({ clientId, customer, onClose, onChanged }: {
  clientId: string;
  customer: { id: string; name: string | null; email: string | null; shared: boolean; source: ClaimSource };
  onClose: () => void;
  /** Called once, when the dialog closes, if Stripe may have changed: with the address Stripe confirmed, when it did. */
  onChanged: (email?: string | null) => void;
}) {
  // Fixed at open: the record behind may re-render; this dialog replaces this address only.
  const [target] = useState(customer);
  const who = target.name ?? "this customer";
  const title = target.email ? "Change invoice email" : "Add invoice email";
  const [draft, setDraft] = useState("");
  const [checked, setChecked] = useState(false);
  const [step, setStep] = useState<Step>({ at: "edit" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; final: boolean } | null>(null);
  const [lost, setLost] = useState(false);
  const touched = useRef(false);
  const confirmed = useRef<{ email: string | null } | null>(null);
  const stepFocus = useRef<HTMLElement | null>(null);
  const errorFocus = useRef<HTMLButtonElement | null>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    stepFocus.current?.focus();
  }, [step.at]);
  // A refusal can take away the button that had focus: the way out gets it, so the keyboard stays in the dialog.
  useEffect(() => { if (error) errorFocus.current?.focus(); }, [error]);
  // Stable onClose for ModalDialog; Escape does nothing mid-request.
  const latest = useRef({ busy, onClose, onChanged });
  useEffect(() => { latest.current = { busy, onClose, onChanged }; });
  const close = useCallback(() => {
    if (latest.current.busy) return;
    if (touched.current) latest.current.onChanged(confirmed.current ? confirmed.current.email : undefined);
    latest.current.onClose();
  }, []);

  const to = cleanEmail(draft);
  const unchanged = to !== null && sameEmail(to, target.email);
  const problem = !checked ? null : !draft.trim() ? "Type the new email address." : !to ? "That isn't one email address. Check it and try again." : unchanged ? "Stripe already sends to this address." : null;
  const next = () => {
    setChecked(true);
    setError(null);
    if (to && !unchanged) setStep({ at: "confirm", to });
  };

  const save = async () => {
    if (step.at !== "confirm") return;
    setBusy(true);
    setError(null);
    touched.current = true;
    let out: { status: number; body: Answer } | null = null;
    try {
      const res = await fetch("/api/workspace/clients/billing/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, customerId: target.id, from: target.email, to: step.to }),
      });
      out = { status: res.status, body: ((await res.json().catch(() => null)) as Answer | null) ?? {} };
    } catch {
      out = null;
    }
    setBusy(false);
    if (out?.body.ok) {
      setLost(false);
      // Saved, or Stripe had it already: either way Stripe now sends to this address.
      confirmed.current = { email: out.body.email ?? step.to };
      if (out.body.done) setStep({ at: "done", title: lost ? "It went through" : "Nothing to change", text: out.body.message ?? "Stripe already has this address." });
      else setStep({ at: "done", title: "Invoice email changed", text: `Stripe now sends ${who}'s invoices, receipts and payment reminders to ${out.body.email ?? step.to}.` });
    } else if (!out || out.body.uncertain) {
      setLost(true);
      setError({ text: LOST, final: false });
    } else {
      setError({
        text: out.body.error ?? (out.status === 404 ? "This is not available to you." : `Something went wrong (HTTP ${out.status}).`),
        final: FINAL.has(out.status),
      });
    }
  };

  const byName = target.source === "name match" ? (
    <p className="rb-cx-warn" data-testid="rb-mail-byname">
      This Stripe customer counts for this client only because its name matches. Check it really is theirs before changing where its invoices go.
    </p>
  ) : null;

  return (
    <ModalDialog open onClose={close} width={520} label={`${title} for ${who}`}>
      <div className="rb-dlg" data-testid="rb-mail">
        <header>
          <h2>{title}</h2>
          <p>{who}</p>
          <p className="rb-cx-ident">Stripe {target.id}</p>
        </header>

        {step.at === "edit" ? (
          <div className="rb-dlg-body">
            <div className="rb-sum">
              <dl>
                <dt>Sends to now</dt><dd data-testid="rb-mail-now">{target.email ?? "No address"}</dd>
              </dl>
            </div>
            <label className="rb-field" htmlFor="rb-mail-to">
              <span>New email</span>
              <input id="rb-mail-to" className="ds-input" type="email" inputMode="email" autoComplete="off" spellCheck={false} placeholder="name@company.com"
                ref={(el) => { if (step.at === "edit") stepFocus.current = el; }}
                aria-invalid={problem ? true : undefined} aria-describedby={problem ? "rb-mail-problem" : undefined}
                value={draft} onChange={(e) => { setDraft(e.target.value); setChecked(false); }}
                onBlur={() => { if (draft.trim()) setChecked(true); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); next(); } }} />
            </label>
            {problem ? <div className="ds-field-err" id="rb-mail-problem" role="alert">{problem}</div> : null}
            {byName}
            {target.shared ? <p className="rb-cx-warn">This Stripe customer is shared with another client, so that client&rsquo;s invoices go to the new address too.</p> : null}
            <p className="rb-cx-note">Stripe sends this customer&rsquo;s invoices, receipts and payment reminders to one address. To copy in a second person as well, add them in Stripe&rsquo;s dashboard: the OS can&rsquo;t set extra recipients.</p>
            <footer>
              <button type="button" className="rx-btn" onClick={close}>Close</button>
              <button type="button" className="rx-btn solid" onClick={next}>Continue</button>
            </footer>
          </div>
        ) : step.at === "confirm" ? (
          <div className="rb-dlg-body">
            <div className="rb-sum" data-testid="rb-mail-confirm" tabIndex={-1} ref={(el) => { if (step.at === "confirm") stepFocus.current = el; }}>
              <b>Send {who}&rsquo;s invoices to {step.to}?</b>
              <dl>
                <dt>From now on</dt><dd>{step.to}</dd>
                <dt>No longer</dt><dd>{target.email ?? "No address before"}</dd>
                <dt>Already sent</dt><dd>Not sent again</dd>
              </dl>
              <p>New invoices go to the new address, and so do invoices still in draft. An invoice Stripe has already sent stays with the address it went to.</p>
            </div>
            {byName}
            {target.shared ? <p className="rb-cx-warn">Shared with another client: their invoices go to {step.to} too.</p> : null}
            {error ? <div className="ds-field-err" role="alert">{error.text}</div> : null}
            <footer>
              {lost || error
                ? <button type="button" className="rx-btn" onClick={close} disabled={busy} ref={errorFocus}>{lost ? "Close and check" : "Close"}</button>
                : <button type="button" className="rx-btn" onClick={() => { setStep({ at: "edit" }); setError(null); }} disabled={busy}>Back</button>}
              {error?.final && !lost ? null : (
                <button type="button" className="rx-btn solid" onClick={() => void save()} disabled={busy}>
                  {busy ? "Changing…" : lost ? "Change email: try again" : error ? "Try again" : "Change email"}
                </button>
              )}
            </footer>
          </div>
        ) : (
          <div className="rb-dlg-body">
            <div className="rb-sum ok" role="status">
              <b>{step.title}</b>
              <p>{step.text}</p>
            </div>
            <footer>
              <button type="button" className="rx-btn solid" onClick={close} ref={(el) => { if (step.at === "done") stepFocus.current = el; }}>Close</button>
            </footer>
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
