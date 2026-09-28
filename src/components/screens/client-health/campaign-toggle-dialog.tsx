"use client";

import { useEffect, useId, useState } from "react";

import type { ToggleAction, ToggleOutcome, TogglePlan } from "@/lib/tools/client-health/campaign-toggle";
import type { ToggledCampaign } from "@/lib/tools/client-health/types";

import { Dialog, DialogBody, DialogFoot, DialogHead } from "./dialog";

/*
 * Campaign Play/Pause for one client: preview (live statuses, nothing sent) →
 * confirm → apply → per-campaign results, all in one dialog. PORTED from the
 * tool's app/Dashboard.tsx (1590588); the server is
 * /api/tools/client-health/clients/campaigns.
 *
 * Campaigns only. The client's status, portal and billing are the lifecycle on
 * the Clients page and are not touched here.
 */

type Phase = "loading" | "confirm" | "applying" | "done" | "error";

const ENDPOINT = "/api/tools/client-health/clients/campaigns";

export function CampaignToggleDialog({
  clientId, clientName, action, onClose, onApplied,
}: {
  clientId: string;
  clientName: string;
  action: ToggleAction;
  onClose: () => void;
  /** After a run — with what the toggle now holds paused, for ▶ / ⏸. */
  onApplied: (held: ToggledCampaign[]) => void;
}) {
  const titleId = useId();
  const [phase, setPhase] = useState<Phase>("loading");
  const [plan, setPlan] = useState<TogglePlan | null>(null);
  const [outcomes, setOutcomes] = useState<ToggleOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`${ENDPOINT}?clientId=${encodeURIComponent(clientId)}&action=${action}`, { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        if (live) { setPlan(body.plan as TogglePlan); setPhase("confirm"); }
      } catch (e) {
        if (live) { setError((e as Error).message); setPhase("error"); }
      }
    })();
    return () => { live = false; };
  }, [clientId, action]);

  async function apply() {
    setPhase("applying");
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      const result = body.result as { plan: TogglePlan; outcomes: ToggleOutcome[]; held: ToggledCampaign[] };
      setPlan(result.plan);
      setOutcomes(result.outcomes);
      setPhase("done");
      onApplied(result.held ?? []);
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }

  const verb = action === "pause" ? "Pause" : "Resume";
  const n = plan?.willChange.length ?? 0;
  const close = () => { if (phase !== "applying") onClose(); };

  return (
    <Dialog onClose={close} labelledBy={titleId} width={540}>
      <DialogHead id={titleId} title={`${verb} campaigns — ${clientName}`} />
      <DialogBody>
        <div className="ds-toggle-body">
          {phase === "loading" ? <p>Checking live campaign status on Instantly and Bison…</p> : null}
          {phase === "error" ? <p className="err" role="alert">Could not complete: {error}</p> : null}

          {plan && (phase === "confirm" || phase === "applying") ? (
            <>
              <p>
                {n === 0
                  ? `Nothing to ${action}.`
                  : action === "pause"
                    ? `These ${n} campaign(s) will stop sending. Client status, portal and billing are not changed.`
                    : `These ${n} campaign(s), paused from here, will start sending again.`}
              </p>
              {action === "resume" && plan.willChange.some((c) => c.platform === "bison") ? (
                <p className="warn">Bison resumes by queuing: those campaigns start emailing their remaining leads straight away.</p>
              ) : null}
              <ul>
                {plan.willChange.map((c) => (
                  <li key={c.platform + c.id}>
                    <span className={`ds-badge ${c.platform === "instantly" ? "t-brand" : "t-violet"}`}>
                      {c.platform === "instantly" ? "Instantly" : "Bison"}
                    </span>
                    {c.name}
                  </li>
                ))}
              </ul>
              {plan.skipped.length > 0 ? (
                <details>
                  <summary>{plan.skipped.length} left alone</summary>
                  <ul>
                    {plan.skipped.map((s) => (
                      <li key={s.campaign.platform + s.campaign.id}>
                        {s.campaign.name} <em>— {s.reason}</em>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : null}

          {phase === "done" && outcomes ? (
            <>
              <p>
                {outcomes.filter((o) => o.ok).length} of {outcomes.length} {action === "pause" ? "paused" : "resumed"}.
              </p>
              <ul>
                {outcomes.map((o) => (
                  <li key={o.campaign.platform + o.campaign.id} className={o.ok ? "ok" : "fail"}>
                    {o.ok ? "✓" : "✕"} {o.campaign.name}
                    {!o.ok && o.error ? <em> — {o.error}</em> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </DialogBody>
      <DialogFoot>
        {phase === "done" || phase === "error" ? (
          <button type="button" className="ds-btn primary" onClick={onClose}>Close</button>
        ) : (
          <>
            <button type="button" className="ds-btn" disabled={phase === "applying"} onClick={onClose}>Cancel</button>
            <button
              type="button"
              className={`ds-btn ${action === "pause" ? "danger-solid" : "primary"}`}
              disabled={phase !== "confirm" || n === 0}
              onClick={() => void apply()}
            >
              {phase === "applying" ? "Working…" : `${verb} ${n}`}
            </button>
          </>
        )}
      </DialogFoot>
    </Dialog>
  );
}
