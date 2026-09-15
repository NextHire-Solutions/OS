/*
 * The network-free parts of the Gmail connection. Ported from the tool's
 * `lib/google-oauth.ts` and `lib/gmail-health.ts`.
 */

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify", // read replies
  "openid",
  "email",
];

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export function buildConsentUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline", // needed to receive a refresh token
    prompt: "consent", // force a refresh token even on re-connect
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

/** Google revoked the refresh token: password change, revoked access, or the OAuth app in Testing mode. */
export const isInvalidGrant = (error: string | undefined): boolean => /invalid_grant/i.test(error ?? "");

export const INVALID_GRANT_WHY =
  "Google revoked the mailbox's access token (password change, revoked access, or the OAuth app is in Testing mode).";

/** Don't re-announce old mail: pings only for replies received in the last 48h. */
export const RECENT_REPLY_MS = 48 * 3600_000;

/** Slack alerts repeat daily while the connection stays broken. */
export const REALERT_MS = 24 * 3600_000;

export interface HealthMemory { ok: boolean; lastAlertAt: number }

/** Alert on the first break, then once a day while still broken. */
export function shouldAlert(prev: HealthMemory | undefined, nowMs: number): { alert: boolean; stale: boolean } {
  const firstBreak = !prev || prev.ok;
  const stale = !!prev && !prev.ok && nowMs - prev.lastAlertAt > REALERT_MS;
  return { alert: firstBreak || stale, stale };
}
