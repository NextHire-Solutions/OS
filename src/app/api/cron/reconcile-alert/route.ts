import { NextResponse } from "next/server";

import { optionalEnv } from "@/lib/env";
import { bearerAccepted } from "@/lib/tools/onboarding/webhook-auth";
import { alertText, buildReconcileAlert, type ReconcileAlertInput } from "@/lib/reconcile/alert";
import {
  gatherAliasDriftReport,
  gatherCoverageReport,
  gatherDuplicateReport,
  gatherLinkReport,
  gatherStatusReport,
} from "@/lib/reconcile/status-readers";

/*
 * Drift detection that comes to you — §16's second half.
 *
 *   "We need to know IMMEDIATELY that there is a synchronization problem."
 *   "We should not have to discover these issues manually."
 *
 * The Consistency screen answered the first line and not the second: it tells
 * you nothing unless you open it. This runs on a schedule and posts to Slack
 * only when there is something a person can act on.
 *
 * Schedule it like the other crons:
 *   curl -H 'Authorization: Bearer <OS_CRON_SECRET>' \
 *     'https://os.brokerstaffer.com/api/cron/reconcile-alert?send=1'
 *
 * DAILY, not every ten minutes. Every finding here is a state that persists
 * until a person fixes it, so a short interval would repeat the same message
 * all day and get the channel muted. Add `&always=1` for a daily all-clear.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *
 *   * REPORT-ONLY BY DEFAULT. Without ?send=1 it posts nothing and just returns
 *     what it would have said, so the schedule can be pointed at it and read
 *     before anyone wires up the channel.
 *   * Auth fails CLOSED: no OS_CRON_SECRET, no access. This route reads every
 *     client in four databases.
 *   * Each of the four checks is caught separately. One unreachable database
 *     degrades to "the X check failed", which is itself reported as urgent —
 *     never to a quiet "everything agrees", which is the one outcome that would
 *     make this worse than having nothing.
 *   * Slack is best-effort: an unset channel is a no-op, and a Slack failure is
 *     reported in the response rather than failing the run.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function postToSlack(text: string): Promise<{ sent: boolean; error?: string }> {
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

async function run(request: Request) {
  const auth = bearerAccepted(
    request.headers.get("authorization") ??
      (new URL(request.url).searchParams.get("token")
        ? `Bearer ${new URL(request.url).searchParams.get("token")}`
        : null),
    optionalEnv("OS_CRON_SECRET"),
  );
  if (auth === "unconfigured") {
    return NextResponse.json(
      { error: "OS_CRON_SECRET is not set — this route is closed" },
      { status: 503 },
    );
  }
  if (auth === "denied") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const send = params.get("send") === "1";
  const always = params.get("always") === "1";

  const failedChecks: ReconcileAlertInput["failedChecks"] = [];
  const fail = (check: string) => (error: unknown) => {
    failedChecks.push({
      check,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  };

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

  const unreadable = [
    ...(statuses?.unreadable ?? []),
    ...(coverage?.unreadable ?? []),
  ].map(String);

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
  const screenUrl = optionalEnv("OS_PUBLIC_URL")
    ? `${optionalEnv("OS_PUBLIC_URL")!.replace(/\/$/, "")}/consistency`
    : "https://os.brokerstaffer.com/consistency";

  const text = alert.actionable
    ? alertText(alert, screenUrl)
    : always
      ? `*${alert.title}*\n${alert.lines.map((l) => `• ${l}`).join("\n")}`
      : null;

  let slack: { sent: boolean; error?: string } = { sent: false, error: "not sent" };
  if (send && text) slack = await postToSlack(text);
  else if (send) slack = { sent: false, error: "nothing to report" };

  return NextResponse.json({
    ok: true,
    // false = report only. The schedule can read this before the channel is set.
    applied: send,
    alert,
    input,
    text,
    slack,
    generatedAt: new Date().toISOString(),
  });
}

export async function GET(request: Request) {
  return run(request);
}
export async function POST(request: Request) {
  return run(request);
}
