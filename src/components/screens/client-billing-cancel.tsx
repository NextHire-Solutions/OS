"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import type { BillingNowView } from "@/lib/clients/billing-model";
import type { CancelWhen } from "@/lib/clients/billing-cancel";

/*
 * Cancel a client's subscription — or take back a cancellation set for the end
 * of the period — from the Billing tab (27 Oct; Eddy and Amy only; the plan is
 * in billing-cancel.ts). Always two steps: choose and review (the OS reads the
 * subscription from Stripe and checks it, sending nothing), then confirm.
 * Cancelling immediately cannot be undone, so its confirm button stays off
 * until the client's name is typed.
 *
 * THE SUBSCRIPTION IS FIXED WHEN THE DIALOG OPENS (audit, 27 Oct): every
 * request names that one, whatever the tab behind shows meanwhile, and the tab
 * is re-read only when the dialog closes — so a retry can never reach a
 * client's OTHER subscription. When Stripe's answer is lost after the change
 * was sent, the dialog says it may have gone through and offers only Close or
 * the SAME request again (same key).
 *
 * What Stripe does with money owed was proven in TEST mode: set for the end of
 * the period, it keeps collecting the unpaid invoice until then; cancelled
 * immediately, it stops collecting that subscription's unpaid invoice (left
 * open). Another subscription on the same customer is not touched.
 */

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
/** "Nov 12, 2026" for an Eastern day ("2026-11-12") or an ISO moment. */
const fmt = (d: string | null) => {
  if (!d) return "—";
  const at = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00Z`) : new Date(d);
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
};
const same = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

type Answer = {
  ok?: boolean; error?: string; uncertain?: boolean;
  done?: boolean; message?: string; endsAt?: string | null;
  preview?: { status: string; endsAt: string | null; periodEnd: string | null };
  result?: { status: string; cancelAtPeriodEnd: boolean; endsAt: string | null };
};
type Step =
  | { at: "choose" }
  | { at: "confirm"; key: string; endsAt: string | null }
  | { at: "done"; text: string; detail: string };

const LOST = "Stripe didn't confirm — it may still have gone through. Close this to see the subscription as Stripe has it now. Pressing the button again here is safe: it acts on this same subscription only, and never twice.";

export function CancelSubscriptionDialog({ clientId, clientName, now, others, mode, onClose, onChanged }: {
  clientId: string;
  clientName: string;
  now: BillingNowView;
  /** The client's other subscriptions still running — this cancels only this one. */
  others: number;
  /** cancel: stop it; keep: take back a cancellation set for the end of the period. */
  mode: "cancel" | "keep";
  onClose: () => void;
  /** Called once, when the dialog closes, if anything may have changed. */
  onChanged: () => void;
}) {
  // Fixed at open: the tab behind may re-render; this dialog acts on this subscription only.
  const [target] = useState(now);
  const keep = mode === "keep";
  const scheduled = !!target.cancelsOn;
  // "At the end of the period" only for a subscription running to a charge, not one already set to stop.
  const canWait = !scheduled && !!target.nextBilling && !["incomplete", "paused", "trial"].includes(target.state);
  const owed = Math.max(target.unpaid, target.due ?? 0);
  const [when, setWhen] = useState<CancelWhen | null>(canWait ? "end" : null);
  const [typed, setTyped] = useState("");
  const [step, setStep] = useState<Step>({ at: "choose" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const touched = useRef(false);
  const stepFocus = useRef<HTMLElement | null>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    stepFocus.current?.focus();
  }, [step.at]);
  // Stable onClose for ModalDialog (it re-runs its focus effect when onClose changes); Escape does nothing mid-request.
  const latest = useRef({ busy, onClose, onChanged });
  useEffect(() => { latest.current = { busy, onClose, onChanged }; });
  const close = useCallback(() => {
    if (latest.current.busy) return;
    if (touched.current) latest.current.onChanged();
    latest.current.onClose();
  }, []);

  const plan = `${target.product ?? "Subscription"} · ${money(target.amount)} ${target.every}`;
  const ident = `since ${fmt(target.since)} · Stripe ${target.subscriptionId}`;

  /** null: no answer reached the browser at all. */
  const send = async (preview: boolean, key: string, w: CancelWhen): Promise<{ status: number; body: Answer } | null> => {
    try {
      const res = await fetch("/api/workspace/clients/billing/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, subscriptionId: target.subscriptionId, action: keep ? "keep" : "cancel", when: w, key, preview }),
      });
      return { status: res.status, body: ((await res.json().catch(() => null)) as Answer | null) ?? {} };
    } catch {
      return null;
    }
  };
  const failure = (out: { status: number; body: Answer }) =>
    out.body.error ?? (out.status === 404 ? "This is not available to you." : `Something went wrong (HTTP ${out.status}).`);
  const finished = (text: string, detail: string) => { setLost(false); setStep({ at: "done", text, detail }); };

  const review = async () => {
    const w: CancelWhen = keep ? "end" : when ?? "end";
    if (!keep && !when) return;
    setBusy(true);
    setError(null);
    // One key per confirmation: a double click or a retry does it once.
    const key = crypto.randomUUID();
    const out = await send(true, key, w);
    setBusy(false);
    if (out?.body.ok && out.body.done) { touched.current = true; finished("Nothing to change", `${out.body.message ?? "Stripe already has it this way."}${out.body.endsAt ? ` (${fmt(out.body.endsAt)})` : ""}`); }
    else if (out?.body.ok && out.body.preview) setStep({ at: "confirm", key, endsAt: out.body.preview.endsAt });
    else setError(out ? failure(out) : "The OS could not be reached. Nothing was changed — try again.");
  };

  const confirm = async () => {
    if (step.at !== "confirm") return;
    const w: CancelWhen = keep ? "end" : when ?? "end";
    setBusy(true);
    setError(null);
    touched.current = true;
    const out = await send(false, step.key, w);
    setBusy(false);
    if (out?.body.ok) {
      const r = out.body.result;
      const only = others ? " on this subscription" : "";
      if (out.body.done) finished(lost ? "It went through" : "Nothing to change", out.body.message ?? "Stripe already has it this way.");
      else if (keep) finished("Subscription kept", `${clientName} stays on ${plan}. The next charge is ${fmt(target.nextBilling ?? target.cancelsOn)}.`);
      else if (r?.cancelAtPeriodEnd) finished(`Cancels on ${fmt(r.endsAt)}`, `No new charges${only}. ${clientName} stays subscribed until then, and it can be kept until that day.`);
      else finished("Subscription cancelled", `Stopped ${fmt(r?.endsAt ?? new Date().toISOString())}. Nothing more is charged${only}.`);
    } else if (!out || out.body.uncertain) {
      setLost(true);
      setError(LOST);
    } else setError(failure(out));
  };

  const title = keep ? "Keep subscription" : scheduled ? "Cancel subscription now" : "Cancel subscription";
  const typedOk = keep || when !== "now" || same(typed, clientName);

  return (
    <ModalDialog open onClose={close} width={560} label={`${title} — ${clientName}`}>
      <div className="rb-dlg" data-testid="rb-cancel">
        <header>
          <h2>{title}</h2>
          <p>{clientName} · {plan}</p>
          <p className="rb-cx-ident">{ident}</p>
        </header>

        {step.at === "choose" ? (
          <div className="rb-dlg-body">
            {keep ? (
              <div className="rb-sum" tabIndex={-1} ref={(el) => { if (step.at === "choose") stepFocus.current = el; }}>
                <b>Set to cancel on {fmt(target.cancelsOn)}</b>
                <p>Keeping it takes the cancellation back: Stripe charges {money(target.amount)} on {fmt(target.nextBilling ?? target.cancelsOn)} and carries on {target.every}.</p>
              </div>
            ) : (
              <fieldset className="rb-cx-when">
                <legend>When should it stop?</legend>
                <label className={`rb-cx-opt${when === "end" ? " on" : ""}${canWait ? "" : " off"}`}>
                  <input type="radio" name="rb-cx-when" value="end" checked={when === "end"} disabled={!canWait} onChange={() => setWhen("end")} autoFocus={canWait} />
                  <span>
                    <b>{scheduled ? `Already set for ${fmt(target.cancelsOn)}` : `At the end of the period${canWait ? ` — ${fmt(target.nextBilling)}` : ""}`}</b>
                    <small>{scheduled ? "It stops on its own then. Choose Immediately to stop it now instead."
                      : !canWait ? "Not available: this subscription has no paid period to run to."
                      : owed > 0 ? `No new charges. Stripe still collects the unpaid ${money(owed)} invoice until then. It can be taken back until that day.`
                      : "No new charges. The client stays subscribed until then, already paid for. It can be taken back until that day."}</small>
                  </span>
                  {canWait ? <em>Recommended</em> : null}
                </label>
                <label className={`rb-cx-opt${when === "now" ? " on" : ""}`}>
                  <input type="radio" name="rb-cx-when" value="now" checked={when === "now"} onChange={() => setWhen("now")} autoFocus={!canWait} />
                  <span>
                    <b>Immediately</b>
                    <small>{owed > 0
                      ? `Stops today. Stripe stops collecting its unpaid ${money(owed)} invoice (left open). No refund for the rest of the period. This cannot be undone.`
                      : "Stops today. No refund for the rest of the period and no final invoice. This cannot be undone."}</small>
                  </span>
                </label>
              </fieldset>
            )}
            {others ? <p className="rb-cx-warn">{clientName} has {plural(others, "other subscription")} still running. {keep ? "Only this one is kept." : "Only this one is cancelled"}{keep ? "" : " — the others keep charging."}</p> : null}
            <p className="rb-cx-note">This changes billing in Stripe only. The client&rsquo;s status in the OS and their portal stay as they are — change the status on the record if they are leaving.</p>
            {error ? <div className="ds-field-err" role="alert">{error}</div> : null}
            <footer>
              <button type="button" className="rx-btn" onClick={close} disabled={busy}>Close</button>
              <button type="button" className="rx-btn solid" onClick={() => void review()} disabled={busy || (!keep && !when)}>{busy ? "Checking with Stripe…" : "Review"}</button>
            </footer>
          </div>
        ) : step.at === "confirm" ? (
          <div className="rb-dlg-body">
            <div className="rb-sum" data-testid="rb-cancel-confirm" tabIndex={-1} ref={(el) => { stepFocus.current = el; }}>
              <b>{keep ? `Keep ${clientName}'s subscription?` : when === "end" ? `Cancel ${clientName}'s subscription on ${fmt(step.endsAt)}?` : `Cancel ${clientName}'s subscription now?`}</b>
              <dl>
                <dt>Subscription</dt><dd>{plan}</dd>
                <dt>Stripe</dt><dd>{target.subscriptionId} · since {fmt(target.since)}</dd>
                {keep ? (
                  <><dt>Next charge</dt><dd>{money(target.amount)} on {fmt(target.nextBilling ?? target.cancelsOn)}</dd></>
                ) : when === "end" ? (
                  <><dt>Stops</dt><dd>{fmt(step.endsAt)} — the end of the current period</dd><dt>Charges</dt><dd>{owed > 0 ? `No new ones; the unpaid ${money(owed)} is still collected` : "None after today"}</dd></>
                ) : (
                  <><dt>Stops</dt><dd>Today, the moment you confirm</dd><dt>Refund</dt><dd>None for the rest of the period</dd>{owed > 0 ? <><dt>Unpaid</dt><dd>{money(owed)} — Stripe stops collecting it</dd></> : null}</>
                )}
              </dl>
              <p>{keep ? "The cancellation is taken back; nothing is charged today."
                : when === "end" ? "Stripe will not start a new period. Until that day it can be taken back with Keep subscription."
                : "Stripe ends the subscription at once. It cannot be restarted — a new subscription would have to be created."}</p>
            </div>
            {others && !keep ? <p className="rb-cx-warn">Only this subscription — {plural(others, "other")} keep{others === 1 ? "s" : ""} charging.</p> : null}
            {!keep && when === "now" && !lost ? (
              <label className="rb-field" htmlFor="rb-cx-type">
                <span>Type <b className="rb-cx-name">{clientName}</b> to confirm</span>
                <input id="rb-cx-type" className="ds-input" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
              </label>
            ) : null}
            {error ? <div className="ds-field-err" role="alert">{error}</div> : null}
            <footer>
              {lost
                ? <button type="button" className="rx-btn" onClick={close} disabled={busy}>Close and check</button>
                : <button type="button" className="rx-btn" onClick={() => { setStep({ at: "choose" }); setError(null); setTyped(""); }} disabled={busy}>Back</button>}
              <button type="button" className={`rx-btn solid${keep ? "" : " rb-danger"}`} onClick={() => void confirm()} disabled={busy || (!lost && !typedOk)}>
                {busy ? (keep ? "Keeping…" : "Cancelling…")
                  : keep ? (lost ? "Keep subscription — try again" : "Keep subscription")
                  : when === "end" ? (lost ? "Cancel at period end — try again" : "Cancel at period end")
                  : (lost ? "Cancel now — try again" : "Cancel now")}
              </button>
            </footer>
          </div>
        ) : (
          <div className="rb-dlg-body">
            <div className="rb-sum ok" role="status">
              <b>{step.text}</b>
              <p>{step.detail} The Billing tab is read again from Stripe when you close this.</p>
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
