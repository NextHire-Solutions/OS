import "server-only";

import { getClientRow, type ClientRow } from "./client-detail";
import { STEPS, type Step } from "./steps";
import { STEP_EFFECTS } from "./step-effects";
import { hasDelivery } from "./deliveries";
import { isRefusedStep, REFUSED_REASON, stepPrecondition } from "./step-preconditions";
import {
  bisonBuild, bisonLaunch, bisonPause, buildLeads, buildTeam, pushClient, runSetupAutomation,
  type ActionResult, type ChainReport,
} from "./step-actions";

/**
 * The step actions — validated, described, and RUN, except for the ones that
 * stay switched off.
 *
 * ===========================================================================
 * WHAT FIRES AND WHAT DOES NOT
 * ===========================================================================
 *
 * RUNS from the OS, ported from the tool's `app/actions.ts` and
 * `lib/connectors/*`, with every guard the tool has:
 *
 *   push:client_portal   creates the Master Inbox client + portal + intro macro
 *   push:health_dash     registers the client on Client Health (in-process)
 *   build:team           rebuilds orch_client_team and pushes it to the portal
 *   build:leads          rebuilds the lead list, hands it to the DB app, pings Slack
 *   campaign:build       creates the EmailBison campaign (sequences, schedule, pool, tag)
 *   campaign:launch      STARTS SENDING to every agent imported into the campaign
 *   campaign:pause       stops it
 *   setup:remaining      the post-approval chain, in the tool's order
 *
 * SWITCHED OFF, pending explicit enablement — refused with 501 on every press:
 *
 *   email:*              the seven client emails
 *   payment:link         the Stripe payment link (and the email carrying it)
 *
 * The refusal is not for want of credentials any more; it is a decision. No
 * email leaves for a client and no Stripe link is created from the OS until
 * someone turns that on deliberately, in code. Where the chain reaches an
 * email it records a pending-enablement delivery rather than skipping silently
 * (see deliveries.ts).
 *
 * Every action logs to `orch_connector_deliveries` on success and failure —
 * that table is what `step-state.ts` reads to draw the ✓, and a call that does
 * not log is a call that will be made twice.
 */

export { STEP_EFFECTS, RUNNABLE_KEYS, type StepEffect } from "./step-effects";

export function stepFor(key: string): Step | null {
  return STEPS.find((s) => s.key === key) ?? null;
}

export type StepRefusal = {
  ok: false;
  /** 404 client, 400 bad request or failed precondition, 501 switched off, 502 the action ran and failed. */
  status: 404 | 400 | 501 | 502;
  error: string;
  step?: string;
  label?: string;
  target?: string;
  wouldDo?: string;
  reversible?: boolean;
  credential?: string;
  clientName?: string;
};

export type StepSuccess = {
  ok: true;
  status: 200;
  step: string;
  label?: string;
  target?: string;
  clientName?: string;
  /** What the action reported, e.g. a lead count or a campaign id. */
  detail?: Record<string, unknown>;
  /** For setup:remaining — one line per step of the chain. */
  chain?: ChainReport["steps"];
};

export type StepPlan = StepRefusal | StepSuccess;

async function run(key: string, clientId: string): Promise<ActionResult | ChainReport> {
  const [kind, name] = key.split(":");
  switch (kind) {
    case "push":
      return pushClient(clientId, name as "client_portal" | "health_dash");
    case "build":
      return name === "team" ? buildTeam(clientId) : buildLeads(clientId);
    case "campaign":
      return name === "build" ? bisonBuild(clientId) : name === "launch" ? bisonLaunch(clientId) : bisonPause(clientId);
    case "setup":
      return runSetupAutomation(clientId);
    default:
      return { ok: false, error: `unknown step ${key}` };
  }
}

/**
 * Validate a step request, then run it — or refuse, for the steps that stay off.
 */
export async function planStep(clientId: string, key: string): Promise<StepPlan> {
  const effect = STEP_EFFECTS[key];
  if (!effect) {
    return { ok: false, status: 400, error: `unknown step "${key}"` };
  }

  const client = await getClientRow(clientId);
  if (!client) {
    return { ok: false, status: 404, error: "client not found" };
  }

  const blocked = await stepPrecondition(key, client as ClientRow, hasDelivery);
  if (blocked) {
    /*
     * A refusal the real action would also give. Logged at the same level as an
     * attempt, because "somebody tried to send a second welcome" is worth seeing
     * in the log whether or not the send was wired up.
     */
    console.warn(
      `[onboarding:step] REFUSED (precondition) client=${clientId} "${client.client_name ?? "?"}" step=${key}: ${blocked}`,
    );
    return { ok: false, status: 400, error: blocked, step: key, label: stepFor(key)?.label };
  }

  const label = stepFor(key)?.label ?? key;

  if (isRefusedStep(key)) {
    console.warn(
      `[onboarding:step] SWITCHED OFF — would have called ${effect.target} · ` +
        `client=${clientId} "${client.client_name ?? "?"}" step=${key} · effect: ${effect.effect}`,
    );
    return {
      ok: false,
      status: 501,
      error: `"${label}" did not run. ${REFUSED_REASON} It would call ${effect.target}.`,
      step: key,
      label,
      target: effect.target,
      wouldDo: effect.effect,
      reversible: effect.reversible,
      credential: effect.credential,
      clientName: client.client_name ?? undefined,
    };
  }

  console.warn(
    `[onboarding:step] RUN client=${clientId} "${client.client_name ?? "?"}" step=${key} · ${effect.target} · ${effect.effect}`,
  );
  const result = await run(key, clientId);

  if ("steps" in result) {
    return {
      ok: true, status: 200, step: key, label, target: effect.target,
      clientName: client.client_name ?? undefined, chain: result.steps,
    };
  }
  if (!result.ok) {
    console.error(`[onboarding:step] FAILED client=${clientId} step=${key}: ${result.error}`);
    return {
      ok: false, status: 502, error: result.error ?? `"${label}" failed`,
      step: key, label, target: effect.target, clientName: client.client_name ?? undefined,
    };
  }
  return {
    ok: true, status: 200, step: key, label, target: effect.target,
    clientName: client.client_name ?? undefined, detail: result.detail,
  };
}
