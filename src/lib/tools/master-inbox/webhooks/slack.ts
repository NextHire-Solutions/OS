import { env } from "@/lib/env";

// Thin wrapper around Slack's chat.postMessage. The ONLY module
// that talks to Slack's HTTP API. Every domain-specific notifier
// (lib/webhooks/slack-portal.ts) ultimately calls in here.
//
// Safety contract — three layers of "never crash a portal call":
//   1. Returns a Promise<boolean>, never throws.
//   2. Silent no-op when SLACK_BOT_TOKEN is unset or the target
//      channel arg is empty/undefined (dev / preview envs).
//   3. Caller is expected to wrap the call in `after(...)` from
//      next/server so even if we DID somehow throw, the
//      user-visible response has already been sent.
//
// We use a 5-second hard timeout — Slack's API is usually <300ms
// but a transient hang must not pin the route handler beyond
// that.

const SLACK_API = "https://slack.com/api/chat.postMessage";
const TIMEOUT_MS = 5_000;

export async function postSlackMessage(args: {
  channel: string | undefined;
  text: string;
}): Promise<boolean> {
  const token = env.SLACK_BOT_TOKEN;
  if (!token) return false; // dev / preview / unconfigured
  if (!args.channel) return false; // env getter returned undefined
  if (!args.text || args.text.trim().length === 0) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SLACK_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: args.channel,
        text: args.text,
        // mrkdwn is on by default for the text field. We don't ship
        // blocks today — the message designs Stephanie approved
        // render fine in plain mrkdwn.
      }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;
    if (!res.ok || !body?.ok) {
      console.error("[slack] post failed", {
        status: res.status,
        error: body?.error,
        channel: args.channel,
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error("[slack] post threw", err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
