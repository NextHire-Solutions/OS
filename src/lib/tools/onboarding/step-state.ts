import "server-only";

import { getOnboardingDb } from "./db";
import { STEPS } from "./steps";

/**
 * "Has this step already run?" for every step in the catalogue.
 *
 * Ported from the orchestrator's `lib/step-state.ts`. Drives the ✓ marks on the
 * client screen so the team can see at a glance what is left — the board no
 * longer tells them, because the board is now theirs to arrange. Same sources
 * the tool's own guards use, so the ticks cannot disagree with what the live
 * orchestrator believes.
 *
 * Read-only, on every path. It answers a question about deliveries that already
 * happened; it never causes one.
 *
 * The one change from the tool: `computeStates` takes the client row rather than
 * fetching it, because the client screen has already read that row and a second
 * round trip for the same 40 columns is waste.
 */

export type StepState = { done: boolean; failed: boolean };

/** How far through the step list a client is. `total` is every step in the catalogue. */
export type Progress = { done: number; total: number; pct: number };

/** Only the columns the judgement below actually reads. */
export interface StepClientFacts {
  portal_url?: string | null;
  leads_inreview?: boolean | null;
  bison_leads_exported?: boolean | null;
  bison_campaign_id?: string | null;
}

/**
 * Only the actions a step can be judged by. Filtering server-side keeps this
 * bounded: a client whose Gmail was broken can carry thousands of retry rows for
 * a single action, and a plain "newest N rows" window would be entirely filled
 * by them.
 */
const RELEVANT = [
  ...new Set([
    ...STEPS.filter((s) => s.key.startsWith("email:")).flatMap((s) => {
      const n = s.key.slice(6);
      return [n, `email:${n}`]; // the campaign-live email is logged by the Bison connector
    }),
    "onboard_client",
    "add_team",
    "add_team_contacts",
    "build_campaign",
    "launch_campaign",
    "pause_campaign",
  ]),
];

export async function stepStates(
  clientId: string,
  client: StepClientFacts | null,
): Promise<Record<string, StepState>> {
  const db = getOnboardingDb();
  const rows = (status: "ok" | "error") =>
    db
      .from("orch_connector_deliveries")
      .select("target, action")
      .eq("client_id", clientId)
      .in("action", RELEVANT)
      .eq("status", status)
      .limit(1000);

  const [okRes, badRes] = await Promise.all([rows("ok"), rows("error")]);
  const keys = (res: { data: unknown }) =>
    new Set(((res.data ?? []) as { target: string; action: string }[]).map((d) => `${d.target}:${d.action}`));

  return computeStates(client, keys(okRes), keys(badRes));
}

/** The judgement itself, given the deliveries and the client row. No I/O. */
export function computeStates(
  client: StepClientFacts | null,
  ok: Set<string>,
  bad: Set<string>,
): Record<string, StepState> {
  const out: Record<string, StepState> = {};
  for (const s of STEPS) {
    const [kind, name] = s.key.split(":");
    /*
     * The campaign-live email is sent by the Bison connector, so it logs under
     * target "bison" — accept either spelling rather than showing a sent email
     * as unsent.
     */
    const emailKeys = [`email:${name}`, `bison:email:${name}`];
    let done = false;
    switch (kind) {
      case "email":
        done = emailKeys.some((k) => ok.has(k));
        break;
      case "push":
        done = name === "client_portal" ? !!client?.portal_url : ok.has("health_dash:onboard_client");
        break;
      case "build":
        // Team goes to the portal in two lanes (intro contacts / their roster); either counts.
        done =
          name === "team"
            ? ok.has("client_portal:add_team_contacts") || ok.has("client_portal:add_team")
            : !!client?.leads_inreview || !!client?.bison_leads_exported;
        break;
      case "campaign":
        /*
         * Launch is judged on the delivery, not the status — pausing a live
         * campaign must not make "Launch campaign" look like it never ran.
         */
        done =
          name === "build"
            ? !!client?.bison_campaign_id || ok.has("bison:build_campaign")
            : name === "launch"
              ? ok.has("bison:launch_campaign")
              : ok.has("bison:pause_campaign");
        break;
    }
    out[s.key] = { done, failed: !done && kind === "email" && emailKeys.some((k) => bad.has(k)) };
  }
  return out;
}

/** Count the ticks. This is the "profile completed" figure the team asked for. */
export function progressOf(states: Record<string, StepState>): Progress {
  const total = STEPS.length;
  const done = STEPS.filter((s) => states[s.key]?.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * The same figure for every client at once — the pipeline table needs a whole
 * column of it, and one query per row would be dozens of round trips.
 *
 * Ported from the tool's `progressFor`. Only successful deliveries are read:
 * nothing here is judged on a failure, and the error rows are the ones that
 * pile up (a client with broken Gmail carries thousands of retries).
 */
export async function progressFor(
  clients: ({ id: string } & StepClientFacts)[],
): Promise<Record<string, Progress>> {
  const ids = clients.map((c) => c.id);
  if (!ids.length) return {};

  const { data } = await getOnboardingDb()
    .from("orch_connector_deliveries")
    .select("client_id, target, action")
    .in("client_id", ids)
    .in("action", RELEVANT)
    .eq("status", "ok")
    .limit(10000);

  const ok = new Map<string, Set<string>>();
  for (const d of (data ?? []) as { client_id: string; target: string; action: string }[]) {
    const set = ok.get(d.client_id) ?? new Set<string>();
    set.add(`${d.target}:${d.action}`);
    ok.set(d.client_id, set);
  }

  const out: Record<string, Progress> = {};
  for (const c of clients) {
    out[c.id] = progressOf(computeStates(c, ok.get(c.id) ?? new Set(), new Set()));
  }
  return out;
}
