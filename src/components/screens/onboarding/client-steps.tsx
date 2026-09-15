"use client";

import { useEffect, useState } from "react";

import type { ClientDetail } from "@/lib/tools/onboarding/client-detail";
import { STEPS, labelFor, type Step } from "@/lib/tools/onboarding/steps";
import { patchClient, runStep, type StepResult } from "./actions";
import { Btn } from "./toast";

/*
 * ===========================================================================
 * THE STEP BUTTONS
 * ===========================================================================
 *
 * Seven of the fourteen run from the OS, plus the pause and the chain:
 * create portal, push to Health Dash, build team, build lead list, create /
 * launch / pause the campaign, and "run remaining set-up". Each goes to a route
 * that validates the press in full (the step's own preconditions, the tool's
 * once-only guards) and then runs the ported action, logging to the delivery
 * table the ✓ marks are read from.
 *
 * The other seven — every email to a client — and the Stripe payment link are
 * SWITCHED OFF pending explicit enablement. Press one and the route says so,
 * with what it would have done, and nothing leaves. Where the chain reaches an
 * email it records that as pending in the delivery log rather than skipping it.
 *
 * "Launch campaign" is the one to read twice: it begins sending real email to
 * the agents imported into the campaign — typically several hundred — and
 * nothing unsends it. A ✓ step asks before running again.
 *
 * The copy-approval pair records the client's decision; with the pipeline in
 * automatic mode (Settings) "Mark approved" also runs the set-up chain, as the
 * tool does.
 */

type Notify = (text: string, bad?: boolean) => void;

/** The outcome of a press, worth reading in full — not a toast that vanishes in three seconds. */
function ResultPanel({ r, onDismiss }: { r: StepResult; onDismiss: () => void }) {
  // 400/404: a precondition the real action also refuses. 501: switched off.
  // 502: it ran and the external call failed. 200: it ran.
  const blocked = r.status === 400 || r.status === 404;
  const off = r.status === 501;
  const tone = r.ok
    ? { background: "var(--green-bg)", borderColor: "transparent", color: "var(--green)" }
    : off
      ? { background: "var(--blue-pale)", borderColor: "#CFE0FF", color: "var(--blue-ink)" }
      : null;
  return (
    <div className="anno" role="status" style={{ margin: "14px 0 0", ...tone }}>
      <div style={{ flex: 1 }}>
        {r.ok ? (
          <>
            <b>{r.label ?? "That step"} ran.</b>
            {r.target && <> Called {r.target}.</>}
            {r.detail && Object.keys(r.detail).length > 0 && (
              <div style={{ marginTop: 5 }}>
                {Object.entries(r.detail).map(([k, v]) => (
                  <span key={k} style={{ marginRight: 12 }}>
                    <b>{k}:</b> {String(v)}
                  </span>
                ))}
              </div>
            )}
            {r.chain && (
              <div style={{ marginTop: 7, display: "grid", gap: 3 }}>
                {r.chain.map((s) => (
                  <div key={s.name}>
                    <b>{s.name}</b> — {s.status}
                    {s.detail ? `: ${s.detail}` : ""}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : blocked ? (
          <>
            <b>{r.label ?? "That step"} did not run.</b> {r.error}
          </>
        ) : off ? (
          <>
            <b>Switched off pending enablement.</b> {r.error}
            {r.wouldDo && (
              <div style={{ marginTop: 7 }}>
                <b>What it would do:</b> {r.wouldDo}
              </div>
            )}
            {r.reversible === false && (
              <div style={{ marginTop: 3 }}>
                <b>Reversible:</b> no.
              </div>
            )}
          </>
        ) : (
          <>
            <b>{r.label ?? "That step"} failed.</b> {r.error}
            {r.target && <> The delivery log below has the call to {r.target}.</>}
          </>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{ border: 0, background: "none", font: "inherit", cursor: "pointer", color: "inherit", opacity: 0.6 }}
      >
        ✕
      </button>
    </div>
  );
}

function StepButton({
  clientId,
  step,
  label,
  done,
  failed,
  onResult,
}: {
  clientId: string;
  step: Step;
  label: string;
  done: boolean;
  failed: boolean;
  onResult: (r: StepResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  /*
   * A ✓ step asks before running again.
   *
   * The tool does this with a browser confirm() — `"X" already ran for this
   * client. Run it again?` — because every one of these sends mail or starts a
   * campaign, and a second press is a second email to the client. The
   * workspace's idiom for that question is the same two-press arm the Resume
   * button uses: first press changes the label, second press runs, and it
   * disarms on its own if left alone.
   */
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
      <button
        type="button"
        className="btn"
        disabled={busy}
        data-step={step.key}
        title={armed ? `"${label}" already ran for this client. Press again to run it again.` : step.hint}
        aria-label={`${label} — ${step.hint}`}
        onClick={async () => {
          if (done && !armed) { setArmed(true); return; }
          setArmed(false);
          setBusy(true);
          try {
            onResult(await runStep(clientId, step.key));
          } finally {
            setBusy(false);
          }
        }}
        style={{
          whiteSpace: "nowrap",
          ...(busy ? { opacity: 0.4, cursor: "not-allowed" } : null),
          ...(done
            ? { background: "var(--green-bg)", borderColor: "transparent", color: "var(--green)" }
            : null),
        }}
      >
        {busy ? "…" : armed ? "Run again?" : label}
        {done && !armed ? " ✓" : ""}
      </button>
      {failed && (
        <span style={{ fontSize: 11.5, color: "var(--red)" }}>last attempt failed</span>
      )}
    </div>
  );
}

function Group({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 16 }}>
      <div className="tbl-sub" style={{ fontWeight: 600, color: "var(--ink-2)", marginBottom: 8 }}>
        {title}
      </div>
      {note && (
        <div className="tbl-sub" style={{ marginBottom: 8 }}>
          {note}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

export function ClientSteps({
  data,
  notify,
  onSaved,
}: {
  data: ClientDetail;
  notify: Notify;
  onSaved: () => Promise<void>;
}) {
  const [result, setResult] = useState<StepResult | null>(null);
  const [busy, setBusy] = useState(false);
  const c = data.client;

  /** Every press lands here: a step that ran changes the ✓ marks, so the screen re-reads. */
  async function landed(r: StepResult) {
    setResult(r);
    if (r.ok) {
      await onSaved();
      notify(`${r.label ?? r.step ?? "Step"} ran`);
    }
  }
  const p = data.progress;
  const approved = c.copyStatus === "approved";

  const group = (kind: string) => STEPS.filter((s) => s.kind === kind);

  const render = (steps: Step[]) =>
    steps.map((s) => (
      <StepButton
        key={s.key}
        clientId={c.id}
        step={s}
        label={labelFor(s, data.stepLabels)}
        done={!!data.steps[s.key]?.done}
        failed={!!data.steps[s.key]?.failed}
        onResult={landed}
      />
    ));

  /** One of the off-catalogue actions on this panel. Same route, same panel. */
  async function extra(key: string) {
    setBusy(true);
    try {
      await landed(await runStep(c.id, key));
    } finally {
      setBusy(false);
    }
  }

  async function setCopy(status: "approved" | "rejected") {
    setBusy(true);
    try {
      const r = (await patchClient(c.id, { copyStatus: status })) as { chain?: StepResult["chain"] };
      await onSaved();
      if (r.chain) {
        setResult({ ok: true, enabled: true, status: 200, label: "Set-up chain", chain: r.chain });
        notify("Copy marked approved — the set-up chain ran");
      } else {
        notify(status === "approved" ? "Copy marked approved" : "Copy sent back for another round");
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not record that", true);
    } finally {
      setBusy(false);
    }
  }

  const tone = p.pct === 100 ? "var(--green)" : p.pct >= 50 ? "var(--yellow)" : "var(--red)";

  return (
    <>
      {/* The progress figure the team asked for: how far through the catalogue
          this client is, counted from real delivery rows. */}
      <div style={{ marginBottom: 14 }}>
        <div className="track">
          <i style={{ width: `${p.pct}%`, background: tone }} />
        </div>
        <div className="tbl-sub" style={{ marginTop: 6 }}>
          {p.pct}% · {p.done} of {p.total} steps done
        </div>
      </div>

      <div className="anno" style={{ margin: "0 0 4px" }}>
        <div>
          <b>Set-up and campaign buttons run from here.</b> Portal, Health Dash, team, lead list and
          the campaign go to the real systems — “Launch campaign” begins sending to hundreds of
          agents, with no unsend. <b>The email buttons and the payment link are switched off</b>{" "}
          pending explicit enablement: press one and it says what it would have sent, and nothing
          leaves. A ✓ means it already ran.{" "}
          <a href="/onboarding/settings" style={{ color: "var(--blue)" }}>Rename these buttons</a>
        </div>
      </div>

      <Group title="Emails" note="Switched off in the OS pending explicit enablement — each button reports what it would send.">
        {render(group("email"))}
      </Group>

      <Group title="Set-up">{render([...group("push"), ...group("build")])}</Group>

      <Group title="Campaign">
        {render(group("campaign"))}
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-step="campaign:pause"
          title="Stops the client's campaign sending. The only one of these that undoes something."
          onClick={() => extra("campaign:pause")}
          style={{
            whiteSpace: "nowrap",
            color: "var(--red)",
            ...(busy ? { opacity: 0.4, cursor: "not-allowed" } : null),
          }}
        >
          Pause campaign
        </button>
      </Group>

      {result && <ResultPanel r={result} onDismiss={() => setResult(null)} />}

      <hr style={{ border: 0, borderTop: "1px solid var(--line-soft)", margin: "20px 0 0" }} />

      <Group
        title="Copy approval"
        note="Records the client's decision. With the pipeline set to automatic in Settings, approving also runs the set-up chain below; in manual mode it writes the flag and stops."
      >
        {approved ? (
          <span className="badge s-done">
            <span className="dot" />
            Approved
          </span>
        ) : (
          <Btn primary disabled={busy} onClick={() => setCopy("approved")}>
            Mark approved
          </Btn>
        )}
        <Btn disabled={busy} onClick={() => setCopy("rejected")}>
          Needs another round
        </Btn>
        {c.copyStatus === "rejected" && (
          <span className="badge s-risk">
            <span className="dot" />
            Rejected
          </span>
        )}
      </Group>

      <Group
        title="Run every remaining step at once"
        note="The tool's chain, on demand: portal → onboarding emails → team → Health Dash → campaign → lead list. Steps already done are skipped; the four emails are recorded as pending enablement, not sent."
      >
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-step="setup:remaining"
          title="Runs the whole set-up chain; steps already done are skipped."
          onClick={() => extra("setup:remaining")}
          style={{ whiteSpace: "nowrap", ...(busy ? { opacity: 0.4, cursor: "not-allowed" } : null) }}
        >
          Run remaining set-up
        </button>
      </Group>
    </>
  );
}

/* ============================== PAYMENT ================================== */

const money = (cents: number | null) =>
  cents == null ? "" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The Stripe box.
 *
 * The STATE is live and read from the row — paid or not, how much, and whether a
 * link is outstanding; the Stripe webhook receiver keeps it current. The ACTION
 * is switched off pending explicit enablement: sending a payment link creates a
 * real Stripe Payment Link for a real amount and emails it to the client. The
 * route says so on every press and creates nothing.
 */
export function PaymentBox({ data }: { data: ClientDetail }) {
  const c = data.client;
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<"one_time" | "biweekly" | "monthly">("one_time");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<StepResult | null>(null);

  const valid = !!amount && Number(amount) >= 0.5;

  return (
    <>
      {c.paid ? (
        <div style={{ marginBottom: 10 }}>
          <span className="badge s-done">
            <span className="dot" />
            Paid{c.amountCents ? ` · ${money(c.amountCents)}` : ""}
          </span>
        </div>
      ) : c.paymentUrl ? (
        <div className="tbl-sub" style={{ marginBottom: 10 }}>
          Link sent{c.amountCents ? ` for ${money(c.amountCents)}` : ""} — awaiting payment.
        </div>
      ) : (
        <div className="tbl-sub" style={{ marginBottom: 10 }}>
          No payment link sent yet.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="mut">$</span>
        <input
          className="inp"
          type="number"
          min="0.5"
          step="1"
          value={amount}
          placeholder="Amount"
          aria-label="Payment amount in dollars"
          onChange={(e) => setAmount(e.target.value)}
          style={{ width: 120, minWidth: 0 }}
        />
        <select
          className="sel"
          value={cadence}
          aria-label="Payment cadence"
          onChange={(e) => setCadence(e.target.value as typeof cadence)}
        >
          <option value="one_time">One-time</option>
          <option value="biweekly">Every 2 weeks</option>
          <option value="monthly">Monthly</option>
        </select>
        <Btn
          disabled={busy || !valid || !c.contactEmail}
          data-step="payment:link"
          title="Creates a live Stripe payment link and emails it to the client. Switched off pending explicit enablement."
          onClick={async () => {
            setBusy(true);
            try {
              setRefusal(await runStep(c.id, "payment:link"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "…" : "Send payment link"}
        </Btn>
      </div>

      {!c.contactEmail && (
        <div style={{ fontSize: 13, color: "var(--red)", marginTop: 8 }}>
          This client has no email address on file.
        </div>
      )}

      {/*
        The tool's own warning, from its `stripeMode()`: red before a real
        charge, amber with the test card otherwise. Read off the key's prefix
        when one is set, else the env setting (lib/tools/onboarding/stripe-mode.ts).
      */}
      {data.stripeMode === "live" && (
        <div style={{ marginTop: 10 }}>
          <span className="badge s-risk">
            <span className="dot" />
            live mode — real charges
          </span>
        </div>
      )}
      {data.stripeMode === "test" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <span className="badge s-pending">
            <span className="dot" />
            test mode
          </span>
          <span className="tbl-sub">use card 4242 4242 4242 4242</span>
        </div>
      )}

      {refusal && <ResultPanel r={refusal} onDismiss={() => setRefusal(null)} />}
    </>
  );
}
