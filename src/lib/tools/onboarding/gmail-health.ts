import "server-only";

import { appBaseUrl } from "./env";
import { getAccessToken } from "./google-oauth";
import { INVALID_GRANT_WHY, isInvalidGrant, shouldAlert, type HealthMemory } from "./gmail-pure";
import { notifySlack, slackMention } from "./slack";

/*
 * Gmail connection watchdog. The reply tracking (and, in the tool, every send)
 * hangs off one OAuth refresh token; when Google revokes it (password change,
 * admin revoke, app left in "Testing" mode, 6 months unused) every call fails
 * with invalid_grant — silently, forever.
 *
 * Every scheduler tick: try to mint an access token. On the first failure post
 * a loud Slack alert with the reconnect link, repeat daily while broken, and
 * announce recovery. State is in-memory (a redeploy re-alerts if still broken —
 * that's a feature). The tool's `lib/gmail-health.ts`.
 */

export type GmailHealth = { ok: boolean; connected: boolean; error?: string; checkedAt: string };

const g = globalThis as { __onboardingGmailHealth?: HealthMemory };

export async function checkGmailConnection(): Promise<GmailHealth> {
  const settingsUrl = `${appBaseUrl()}/onboarding/settings`;
  let health: GmailHealth;
  try {
    const t = await getAccessToken();
    health = t
      ? { ok: true, connected: true, checkedAt: new Date().toISOString() }
      : { ok: false, connected: false, error: "no mailbox connected", checkedAt: new Date().toISOString() };
  } catch (e) {
    health = { ok: false, connected: true, error: e instanceof Error ? e.message : String(e), checkedAt: new Date().toISOString() };
  }

  const prev = g.__onboardingGmailHealth;
  const now = Date.now();
  if (!health.ok) {
    const { alert, stale } = shouldAlert(prev, now);
    if (alert) {
      const why = isInvalidGrant(health.error) ? INVALID_GRANT_WHY : health.error ?? "unknown error";
      await notifySlack({
        action: "gmail_disconnected",
        text: `${slackMention()} :rotating_light: *Gmail connection is broken — client emails and reply tracking have STOPPED.*\n> ${why}\nReconnect the mailbox here (30 seconds): ${settingsUrl}\nQueued emails resume automatically once reconnected.${stale ? "\n_(still broken — daily reminder)_" : ""}`,
      }).catch(() => {});
      g.__onboardingGmailHealth = { ok: false, lastAlertAt: now };
    }
  } else {
    if (prev && !prev.ok) {
      await notifySlack({
        action: "gmail_reconnected",
        text: `:white_check_mark: Gmail connection restored — queued client emails and reply tracking are resuming.`,
      }).catch(() => {});
    }
    g.__onboardingGmailHealth = { ok: true, lastAlertAt: prev?.lastAlertAt ?? 0 };
  }
  return health;
}
