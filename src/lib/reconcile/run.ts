import { optionalEnv } from "@/lib/env";
import { alertText, buildReconcileAlert, type ReconcileAlertInput } from "./alert";
import {
  gatherAliasDriftReport,
  gatherCoverageReport,
  gatherDuplicateReport,
  gatherLinkReport,
  gatherStatusReport,
} from "./status-readers";

/*
 * One drift check, callable without HTTP.
 *
 * Extracted from api/cron/reconcile-alert so the in-process schedule and the
 * route run the SAME check. The route kept this logic in its handler, which was
 * fine while nothing else ran it; a scheduler with its own copy would be a
 * second spelling of the rule, and every synchronisation bug in this codebase
 * has come from exactly that.
 *
 * The route keeps auth and parameter parsing. This keeps the decisions.
 */

export interface ReconcileRunOptions {
  /** Post to Slack. False = report only: gather, decide, return, say nothing. */
  send: boolean;
  /** Also report when everything agrees, for a daily all-clear. */
  always: boolean;
}

export interface ReconcileRunResult {
  ok: true;
  /** False means report-only — nothing was posted anywhere. */
  applied: boolean;
  alert: ReturnType<typeof buildReconcileAlert>;
  input: ReconcileAlertInput;
  text: string | null;
  slack: { sent: boolean; error?: string };
  generatedAt: string;
}

export async function postToSlack(text: string): Promise<{ sent: boolean; error?: string }> {
  const token =
    optionalEnv("OS_ALERT_SLACK_BOT_TOKEN") ?? optionalEnv("MASTER_INBOX_SLACK_BOT_TOKEN");
  const channel = optionalEnv("OS_ALERT_SLACK_CHANNEL_ID");
  if (!token || !channel) {
    return { sent: false, error: "OS_ALERT_SLACK_CHANNEL_ID or a bot token is not set" };
  }
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!body?.ok) return { sent: false, error: body?.error ?? `HTTP ${res.status}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : "slack post failed" };
  }
}

/** The Consistency screen, which every alert points at. */
function consistencyUrl(): string {
  const base = optionalEnv("OS_PUBLIC_URL");
  return base
    ? `${base.replace(/\/$/, "")}/consistency`
    : "https://os.brokerstaffer.com/consistency";
}

export async function runReconcileCheck(
  options: ReconcileRunOptions,
): Promise<ReconcileRunResult> {
  const { send, always } = options;

  const failedChecks: ReconcileAlertInput["failedChecks"] = [];
  const fail = (check: string) => (error: unknown) => {
    failedChecks.push({
      check,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  };

  /*
   * Each check is caught separately and on purpose. One unreachable database
   * degrades to "the X check failed", which the alert treats as urgent — never
   * to a quiet "everything agrees", the one outcome that would make this worse
   * than having nothing at all.
   */
  const [statuses, coverage, links, duplicates, aliases] = await Promise.all([
    gatherStatusReport().catch(fail("status")),
    gatherCoverageReport().catch(fail("coverage")),
    gatherLinkReport().catch(fail("coverage gaps")),
    gatherDuplicateReport().catch(fail("duplicate")),
    gatherAliasDriftReport().catch(fail("alias")),
  ]);

  /*
   * `unlinked` is deliberately excluded: a link we have not recorded yet is a
   * gap in our own bookkeeping and is normal for a new client, not two systems
   * disagreeing. Counting it would make this fire on every fresh client.
   */
  const brokenLinks = (links?.findings ?? []).filter((f) => f.kind !== "unlinked").length;

  const unreadable = [...(statuses?.unreadable ?? []), ...(coverage?.unreadable ?? [])].map(String);

  const input: ReconcileAlertInput = {
    statusConflicts: statuses?.conflicts.length ?? 0,
    // `withGaps` is documented as the number to act on: absences with a reason
    // and absences a standing rule covers are counted separately and excluded.
    unexplainedOneSided: coverage?.withGaps ?? 0,
    duplicates: duplicates?.findings.length ?? 0,
    brokenLinks,
    aliasDrift: aliases?.findings.length ?? 0,
    unreadable: [...new Set(unreadable)],
    failedChecks,
    clientsChecked: duplicates?.checked ?? coverage?.rows.length ?? 0,
  };

  const alert = buildReconcileAlert(input);

  const text = alert.actionable
    ? alertText(alert, consistencyUrl())
    : always
      ? `*${alert.title}*\n${alert.lines.map((l) => `• ${l}`).join("\n")}`
      : null;

  let slack: { sent: boolean; error?: string } = { sent: false, error: "not sent" };
  if (send && text) slack = await postToSlack(text);
  else if (send) slack = { sent: false, error: "nothing to report" };

  return {
    ok: true,
    applied: send,
    alert,
    input,
    text,
    slack,
    generatedAt: new Date().toISOString(),
  };
}
