import "server-only";

import { onboardingEnv } from "./env";
import { logDelivery } from "./deliveries";
import { intakeHeadText, intakeThreadChunks, mentionFrom } from "./slack-format";

export { esc } from "./slack-format";

/*
 * Slack notifier — bot token + chat.postMessage. The tool's `lib/slack.ts`.
 *
 * Env (ONBOARDING_ prefix): SLACK_BOT_TOKEN, SLACK_CHANNEL_ID (bot must be in
 * the channel), SLACK_MENTION (optional, default "<!here>"; "" disables),
 * SLACK_ONBOARDING_CHANNEL_ID (the intake announcements).
 *
 * Graceful no-op while env is unset; every send is logged to
 * orch_connector_deliveries.
 */

type SlackResponse = { ok?: boolean; error?: string; ts?: string; channel?: string } | null;

async function postMessage(token: string, body: Record<string, unknown>): Promise<SlackResponse> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ unfurl_links: false, ...body }),
  });
  return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
}

const brief = (r: SlackResponse) => (r ? { ok: r.ok, ts: r.ts, channel: r.channel } : null);

export async function notifySlack(opts: {
  text: string;                 // plain-text fallback (and the message body)
  clientId?: string | null;     // for the delivery log
  action?: string;              // delivery-log action, e.g. "leads_inreview"
}): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const token = onboardingEnv("SLACK_BOT_TOKEN");
  const channel = onboardingEnv("SLACK_CHANNEL_ID");
  const action = opts.action ?? "notify";

  if (!token || !channel) {
    if (opts.clientId) {
      await logDelivery(opts.clientId, "slack", action, "skipped", { text: opts.text }, null,
        "ONBOARDING_SLACK_BOT_TOKEN / ONBOARDING_SLACK_CHANNEL_ID not set");
    }
    return { ok: false, skipped: true };
  }

  let status = "ok", error: string | null = null, resp: SlackResponse = null;
  try {
    resp = await postMessage(token, { channel, text: opts.text });
    if (!resp?.ok) { status = "error"; error = resp?.error ?? "slack error"; }
  } catch (e) { status = "error"; error = e instanceof Error ? e.message : String(e); }

  if (opts.clientId) {
    await logDelivery(opts.clientId, "slack", action, status, { text: opts.text }, brief(resp), error);
  }
  return { ok: status === "ok", error: error ?? undefined };
}

/**
 * New-client intake announcement (#corofy_onboarding): client name in the
 * channel, the full Typeform Q&A neatly formatted in the message's thread.
 */
export async function notifyIntakeSlack(opts: {
  clientId: string;
  clientName: string;
  qa: { q: string; a: string }[];
}): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const token = onboardingEnv("SLACK_BOT_TOKEN");
  const channel = onboardingEnv("SLACK_ONBOARDING_CHANNEL_ID") ?? "C0BGASL1D17";

  const log = (status: string, resp: SlackResponse, error: string | null) =>
    logDelivery(opts.clientId, "slack", "client_intake", status,
      { clientName: opts.clientName, questions: opts.qa.length }, brief(resp), error);

  if (!token) { await log("skipped", null, "ONBOARDING_SLACK_BOT_TOKEN not set"); return { ok: false, skipped: true }; }

  try {
    const head = await postMessage(token, { channel, text: intakeHeadText(opts.clientName) });
    if (!head?.ok) { await log("error", head, head?.error ?? "slack error"); return { ok: false, error: head?.error }; }

    for (const text of intakeThreadChunks(opts.qa)) {
      const r = await postMessage(token, { channel, thread_ts: head.ts, text });
      if (!r?.ok) { await log("error", r, `thread reply: ${r?.error ?? "slack error"}`); return { ok: false, error: r?.error }; }
    }
    await log("ok", head, null);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log("error", null, msg);
    return { ok: false, error: msg };
  }
}

/** The team mention prefix — "<!here>" by default, override with ONBOARDING_SLACK_MENTION ("" disables). */
export function slackMention(): string {
  return mentionFrom(process.env.ONBOARDING_SLACK_MENTION);
}
