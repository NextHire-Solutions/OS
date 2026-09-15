"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  BILLING_INTERVALS, DEFAULTS, PLANS,
  type BillingInterval, type Plan,
} from "@/lib/clients/onboard-plan";
import { ModalDialog } from "@/components/ui/modal-dialog";

/*
 * Onboard a client — the form, and the plan it produces.
 *
 * ---------------------------------------------------------------------------
 * WHY IT SHOWS BEFORE IT SENDS
 *
 * The last of the three writes mints a live, login-free portal URL. There is no
 * undo for that: the address exists the moment the row does. So this form's job
 * is not to submit quickly, it is to show exactly what each tool will be told
 * and let someone read it first.
 *
 * There is deliberately no "run it" button yet. The route behind this one
 * cannot execute a plan at all — executing will be a separate, explicit route.
 * A dry run that could turn into a real run by flipping one argument is a dry
 * run nobody trusts.
 */

const FIELD: React.CSSProperties = { display: "grid", gap: 5 };
const LABEL: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--muted)" };

export function OnboardClient() {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn btn-pri"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Onboard a client
      </button>
      <ModalDialog
        open={open}
        onClose={close}
        width={620}
        label="Onboard a client"
      >
        <OnboardForm onClose={close} />
      </ModalDialog>
    </>
  );
}

function OnboardForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<Plan>(DEFAULTS.plan);
  const [weeklyTarget, setWeeklyTarget] = useState(String(DEFAULTS.weeklyTarget));
  const [aliases, setAliases] = useState("");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [billingInterval, setBillingInterval] = useState<BillingInterval>(DEFAULTS.billingInterval);
  const [billingIntervalDays, setBillingIntervalDays] = useState("");
  const [macroOn, setMacroOn] = useState(false);
  const [brokerage, setBrokerage] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("");
  const [contactEmail, setContactEmail] = useState("");

  const [failed, setFailed] = useState("");
  /*
   * Running is gated behind the preview: `plan_` has to exist before the run
   * button appears at all, so nobody can execute something they have not been
   * — the safe choice is the one you get by not thinking about it.
   */
  /*
   * One button, and it does the whole thing — portal included.
   *
   * This used to be a three-step gate: preview the plan, tick a box to include
   * the portal, then retype the client's name. That was built around the
   * portal being irreversible, but deleting a client now genuinely removes
   * every tool row AND the portal (verified end to end), so the cost of a
   * mistake is a delete rather than a permanent mess. The steps were bought at
   * the price of an onboarding flow nobody could complete without being told
   * how.
   *
   * The server still requires `confirm` to equal the name; it is sent from the
   * name field rather than retyped.
   */
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<{
    ok: boolean;
    portalUrl?: string | null;
    portalFeatures?: string | null;
    legs: { leg: string; status: string; httpStatus?: number; remoteId?: string | null; error?: string }[];
  } | null>(null);

  const router = useRouter();

  /** Close, and refresh the roster so the new client is actually on it. */
  function done() {
    onClose();
    router.refresh();
  }

  /*
   * Everything the three legs need. Checked here so the single button is
   * disabled rather than failing halfway through — a run that creates the
   * Analytics row and then stops is the messy outcome worth avoiding.
   */
  const canOnboard =
    name.trim().length > 0 &&
    Number(weeklyTarget) > 0 &&
    (!macroOn || (fullName.trim().length > 0 && role.trim().length > 0));

  async function runForReal() {
    setRunning(true);
    setFailed("");
    try {
      // The OS record comes first: the run needs something to attach its
      // per-leg history to, and a local row is the cheapest thing to undo.
      const made = await fetch("/api/workspace/clients/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, aliases: aliases.split("\n").map((a) => a.trim()).filter(Boolean) }),
      });
      const madeBody = await made.json();
      if (!made.ok) throw new Error(madeBody?.error ?? `HTTP ${made.status}`);

      const res = await fetch("/api/workspace/clients/onboard/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          osClientId: madeBody.id,
          confirm: name,
          // Every leg, always — including the portal.
          name,
          plan,
          weeklyTarget: Number(weeklyTarget),
          aliases: aliases.split("\n").map((a) => a.trim()).filter(Boolean),
          startDate: startDate || undefined,
          billingInterval,
          billingIntervalDays: billingIntervalDays ? Number(billingIntervalDays) : undefined,
          introMacro: macroOn
            ? {
                brokerage: brokerage || name,
                clientFullName: fullName,
                clientFirstName: fullName.trim().split(/\s+/)[0] ?? "",
                clientRole: role,
                contactEmail: contactEmail.trim() || undefined,
              }
            : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok && !body?.legs) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setRunResult(body);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line-soft)", flex: "none" }}>
        <div style={{ fontWeight: 650, fontSize: 14 }}>Onboard a client</div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>
          {runResult
            ? "Done. Here is what each tool was told."
            : "Creates the client in Analytics, Client Health and Master Inbox, and publishes its portal."}
        </div>
      </div>

      <div style={{ padding: 16, overflowY: "auto", flex: 1, minHeight: 0, display: "grid", gap: 14 }}>
        {/*
          Once the legs have run, the form and the plan are history. They used
          to stay on screen with the outcome appended BELOW them, at the bottom
          of a long scrolling body — so the person who clicked "Run all three"
          saw the form they had just submitted, unchanged, and concluded the
          button had done nothing. It had; the proof was simply off-screen.
        */}
        {runResult ? <RunView result={runResult} /> : <>
        <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <label style={FIELD}>
            <span style={LABEL}>Client name *</span>
            <input className="inp" value={name} onChange={(e) => setName(e.target.value)}
              maxLength={80} placeholder="As the business writes it" />
          </label>
          <label style={FIELD}>
            <span style={LABEL}>Plan *</span>
            <select className="inp" value={plan} onChange={(e) => setPlan(e.target.value as Plan)}>
              {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label style={FIELD}>
            <span style={LABEL}>Weekly target *</span>
            <input className="inp tnum" type="number" min={0} value={weeklyTarget}
              onChange={(e) => setWeeklyTarget(e.target.value)} />
          </label>
          <label style={FIELD}>
            <span style={LABEL}>Start date</span>
            <input className="inp" type="date" value={startDate}
              onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label style={FIELD}>
            <span style={LABEL}>Billing interval</span>
            <select className="inp" value={billingInterval}
              onChange={(e) => setBillingInterval(e.target.value as BillingInterval)}>
              {BILLING_INTERVALS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          {billingInterval === "custom" ? (
            <label style={FIELD}>
              <span style={LABEL}>Interval days *</span>
              <input className="inp tnum" type="number" min={1} value={billingIntervalDays}
                onChange={(e) => setBillingIntervalDays(e.target.value)} />
            </label>
          ) : null}
        </div>

        <label style={FIELD}>
          <span style={LABEL}>Aliases — one per line</span>
          <textarea className="as-ta" rows={2} value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder={"Other spellings a tool already uses\nLeave empty if unsure"} />
        </label>

        <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={macroOn} onChange={(e) => setMacroOn(e.target.checked)}
              style={{ accentColor: "var(--blue)", cursor: "pointer" }} />
            Add introduction details
          </label>
          {macroOn ? (
            <>
              <div style={{ fontSize: 11.5, color: "var(--muted)", margin: "6px 0 0", lineHeight: 1.55 }}>
                Creates this client&rsquo;s intro macro template and powers the <b>Introduce</b>{" "}
                button in a conversation. Every field can be changed later in Edit.
              </div>
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginTop: 12 }}>
                <label style={FIELD}>
                  <span style={LABEL}>Brokerage</span>
                  <input className="inp" value={brokerage} placeholder={name || "Client name"}
                    onChange={(e) => setBrokerage(e.target.value)} />
                </label>
                <label style={FIELD}>
                  <span style={LABEL}>Contact full name *</span>
                  <input className="inp" value={fullName} placeholder="Nicole Collins"
                    onChange={(e) => setFullName(e.target.value)} />
                </label>
                <label style={FIELD}>
                  <span style={LABEL}>Their role *</span>
                  <input className="inp" value={role} placeholder="Team Leader"
                    onChange={(e) => setRole(e.target.value)} />
                </label>
                <label style={FIELD}>
                  <span style={LABEL}>Contact email</span>
                  <input className="inp" type="email" value={contactEmail} placeholder="nicole@brokerage.com"
                    onChange={(e) => setContactEmail(e.target.value)} />
                </label>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.55 }}>
                The contact email is copied into <b>Cc</b> whenever the introduction is inserted.
              </div>
            </>
          ) : null}
        </div>

        {failed ? (
          <p style={{ fontSize: 12.5, color: "var(--red)" }}>{failed}</p>
        ) : null}


        </>}
      </div>

      <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--line-soft)", flex: "none" }}>
        {runResult ? (
          // `router.refresh()` matters as much as the close: without it the
          // roster behind still shows the list from before the run, so a client
          // that was just created correctly appears not to exist.
          <button type="button" className="btn btn-pri" style={{ flex: 1 }} onClick={done}>Done</button>
        ) : (
          <>
            <button type="button" className="btn" style={{ flex: 1 }} onClick={onClose}>Close</button>
            <button
              type="button"
              className="btn btn-pri"
              style={{ flex: 2 }}
              disabled={running || !canOnboard}
              onClick={() => void runForReal()}
              title={canOnboard ? undefined : "Fill in the client name, weekly target, and the macro fields if it is ticked"}
            >
              {running ? "Onboarding…" : "Onboard client"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/*
 * What actually happened, leg by leg.
 *
 * Every leg is shown including the ones that did not run, because "skipped"
 * is the answer to a question someone will otherwise ask twice — was the
 * portal created or not?
 */
function RunView({
  result,
}: {
  result: {
    ok: boolean;
    portalUrl?: string | null;
    portalFeatures?: string | null;
    legs: { leg: string; status: string; httpStatus?: number; remoteId?: string | null; error?: string }[];
  };
}) {
  const tone = (s: string) =>
    s === "done" ? "var(--green)" : s === "failed" ? "var(--red)" : "var(--muted)";
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{
        padding: "9px 12px", background: "var(--inset)", borderBottom: "1px solid var(--line-soft)",
        fontSize: 12.5, fontWeight: 650,
      }}>
        {result.ok ? "Done" : "Stopped — a leg failed"}
      </div>
      <div style={{ padding: 12, display: "grid", gap: 8 }}>
        {result.legs.map((l) => (
          <div key={l.leg} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12.5, flexWrap: "wrap" }}>
            <b style={{ minWidth: 104 }}>{l.leg.replace(/_/g, " ")}</b>
            <span style={{ color: tone(l.status), fontWeight: 600 }}>{l.status}</span>
            {l.httpStatus ? <span className="mut">HTTP {l.httpStatus}</span> : null}
            {l.remoteId ? <span className="mut tnum">{l.remoteId.slice(0, 8)}…</span> : null}
            {l.error ? <span className="mut" style={{ flexBasis: "100%" }}>{l.error}</span> : null}
          </div>
        ))}
        {result.portalFeatures ? (
          <p style={{
            fontSize: 12,
            color: /could NOT/.test(result.portalFeatures) ? "var(--red)" : "var(--muted)",
            margin: "6px 0 0",
          }}>
            {result.portalFeatures}
          </p>
        ) : null}
        {result.portalUrl ? (
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6 }}>
            Portal is live:{" "}
            <a href={result.portalUrl} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>
              {result.portalUrl}
            </a>
          </p>
        ) : (
          <p className="mut" style={{ margin: 0, fontSize: 12, lineHeight: 1.6 }}>
            No portal was created. Run the Master Inbox leg when you are ready to
            publish a customer-facing URL.
          </p>
        )}
      </div>
    </div>
  );
}

