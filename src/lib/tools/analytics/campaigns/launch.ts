/*
 * Launching one campaign (13 Oct, OS feedback: "Add a launch tab to a single
 * campaign").
 *
 * A campaign built in the OS — fanned out from a template, or re-campaigned —
 * lands as a DRAFT, and until now nothing here could start it: Resume is for
 * paused campaigns only, so a draft had to be opened in EmailBison. The Launch
 * tab is where a draft is started, and where what it is about to do is checked
 * first.
 *
 * ---------------------------------------------------------------------------
 * THE CHECKS, AND WHICH ONES STOP A LAUNCH
 *
 * Starting a campaign emails real people, and it is not an undo-able step. So
 * the tab shows what the campaign HAS, read live, before the button is live:
 *
 *   stops the launch       no sequence · no leads · no inboxes · a client
 *                          field ({CLIENT_AREA}) still unfilled · anything
 *                          that could not be read (launching blind is the
 *                          thing this tab exists to prevent)
 *   said, does not stop    no client assigned (the sends would count for
 *                          nobody) · no daily limit on record
 *
 * A PAUSED campaign is started from here too — the same call upstream — with
 * the same checks. One already sending, completed or archived has nothing to
 * launch, and the tab says which.
 *
 * Pure: the facts are gathered by launch-load.ts; this only judges them.
 */

import { unfilledProblem, type ClientFieldKey } from "./client-fields.ts";

export interface LaunchFacts {
  status: string;
  /** Null = could not be read. */
  steps: number | null;
  leads: number | null;
  inboxes: number | null;
  /** Client fields still sitting as placeholders in the sequence. Null = the sequence could not be read. */
  unfilled: ClientFieldKey[] | null;
  /** The client this campaign is assigned to, or null. */
  clientName: string | null;
  /** Deliberately kept out of client reporting (a test, a routing list). */
  excluded: boolean;
  dailyLimit: number | null;
  newLeadsPerDay: number | null;
}

export type CheckState = "ok" | "warn" | "blocked" | "unknown";

export interface LaunchCheck {
  key: "sequence" | "client-fields" | "leads" | "inboxes" | "client" | "limits";
  label: string;
  state: CheckState;
  detail: string;
}

export type LaunchAction = "launch" | "resume";

export interface LaunchVerdict {
  /** What the button does, or null when there is nothing to start. */
  action: LaunchAction | null;
  can: boolean;
  /** Why not, in one sentence — null when it can. */
  reason: string | null;
  checks: LaunchCheck[];
}

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

export function launchActionFor(status: string): { action: LaunchAction | null; why: string | null } {
  const s = status.trim().toLowerCase();
  if (s === "draft") return { action: "launch", why: null };
  if (s === "paused") return { action: "resume", why: null };
  if (["active", "queued", "launching"].includes(s)) return { action: null, why: `This campaign is already ${s === "active" ? "sending" : s}.` };
  if (s === "completed") return { action: null, why: "This campaign has completed. Starting it again is a re-campaign, not a launch." };
  if (s === "archived") return { action: null, why: "This campaign is archived." };
  return { action: null, why: `A campaign in the "${status}" state cannot be launched from here.` };
}

export function launchChecks(f: LaunchFacts): LaunchCheck[] {
  const count = (
    key: LaunchCheck["key"], label: string, value: number | null, unit: string, none: string, many?: string,
  ): LaunchCheck =>
    value === null
      ? { key, label, state: "unknown", detail: `Could not be read from EmailBison just now.` }
      : value > 0
        ? { key, label, state: "ok", detail: plural(value, unit, many) }
        : { key, label, state: "blocked", detail: none };

  const fieldsProblem = f.unfilled === null ? null : unfilledProblem(f.unfilled);

  return [
    count("sequence", "Sequence", f.steps, "step", "No sequence yet — there is nothing to send."),
    f.unfilled === null
      ? { key: "client-fields", label: "Client fields", state: "unknown", detail: "The sequence could not be read, so it could not be checked for unfilled client fields." }
      : fieldsProblem
        ? { key: "client-fields", label: "Client fields", state: "blocked", detail: fieldsProblem }
        : { key: "client-fields", label: "Client fields", state: "ok", detail: "No unfilled client field in the sequence." },
    count("leads", "Leads", f.leads, "lead", "No leads attached — nobody to send to."),
    count("inboxes", "Inboxes", f.inboxes, "inbox", "No inboxes assigned — it cannot send.", "inboxes"),
    f.clientName
      ? { key: "client", label: "Client", state: "ok", detail: f.clientName }
      : {
          key: "client", label: "Client", state: "warn",
          detail: f.excluded
            ? "Excluded from client reporting — its sends will not count for any client."
            : "Not assigned to a client — its sends will not count for any client until it is.",
        },
    f.dailyLimit && f.dailyLimit > 0
      ? {
          key: "limits", label: "Sending limits", state: "ok",
          detail: `${n(f.dailyLimit)} emails a day${f.newLeadsPerDay ? ` · ${n(f.newLeadsPerDay)} new leads a day` : ""}`,
        }
      : { key: "limits", label: "Sending limits", state: "warn", detail: "No daily limit on record — check Settings before it sends." },
  ];
}

export function launchVerdict(f: LaunchFacts): LaunchVerdict {
  const checks = launchChecks(f);
  const { action, why } = launchActionFor(f.status);
  if (!action) return { action: null, can: false, reason: why, checks };

  const blocked = checks.filter((c) => c.state === "blocked");
  const unknown = checks.filter((c) => c.state === "unknown");
  if (blocked.length) {
    return { action, can: false, reason: `Not ready: ${blocked.map((c) => c.label.toLowerCase()).join(", ")}.`, checks };
  }
  if (unknown.length) {
    return {
      action, can: false, checks,
      reason: `${unknown.map((c) => c.label).join(" and ")} could not be checked, so it cannot be started from here yet. Try again in a moment.`,
    };
  }
  return { action, can: true, reason: null, checks };
}

/** What the confirm step says before the button is armed: who it emails, and how fast. */
export function launchSummary(f: LaunchFacts, action: LaunchAction): string {
  const leads = f.leads ?? 0;
  const pace = f.dailyLimit ? ` at up to ${n(f.dailyLimit)} emails a day` : "";
  const verb = action === "launch" ? "Launching" : "Resuming";
  return `${verb} queues this campaign to send to ${plural(leads, "lead")} from ${plural(f.inboxes ?? 0, "inbox", "inboxes")}${pace}. It cannot be undone — only paused.`;
}
