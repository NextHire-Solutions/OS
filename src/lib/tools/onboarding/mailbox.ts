import "server-only";

import { optionalEnv } from "@/lib/env";

import { checkGmailConnection } from "./gmail-health";
import { isInvalidGrant } from "./gmail-pure";
import { getConnectedAccount, oauthConfigured, redirectUri } from "./google-oauth";

/*
 * What the Settings mailbox panel shows. The tool's `/settings` page read
 * (`getConnectedAccount` + a live `checkGmailConnection` when an account is
 * stored — a stored token can be revoked by Google at any time).
 */

export interface MailboxStatus {
  /** The connected Gmail address, when there is one. */
  email: string | null;
  connectedAt: string | null;
  /** Whether a refresh token is stored. Not the same as "working" — see `broken`. */
  hasRefreshToken: boolean;
  /** ONBOARDING_GOOGLE_OAUTH_CLIENT_ID / _SECRET are set, so Connect can complete. */
  configured: boolean;
  /** Connect / Disconnect / Check replies are live here. True when configured. */
  manageableHere: boolean;
  /** The live check failed — Google refused to mint an access token. */
  broken: boolean;
  /** Why, in the tool's words. */
  error: string | null;
  invalidGrant: boolean;
  checkedAt: string | null;
  /** Where Connect sends the browser. */
  connectUrl: string;
  /** The redirect URI to register in Google Cloud. */
  redirectUri: string;
  /** The live tool's settings, for reference. */
  toolUrl: string | null;
}

export const CONNECT_URL = "/api/tools/onboarding/auth/google";

export async function getMailboxStatus(): Promise<MailboxStatus> {
  const base = optionalEnv("ONBOARDING_URL")?.replace(/\/+$/, "") ?? null;
  const configured = oauthConfigured();
  const empty: MailboxStatus = {
    email: null, connectedAt: null, hasRefreshToken: false,
    configured, manageableHere: configured,
    broken: false, error: null, invalidGrant: false, checkedAt: null,
    connectUrl: CONNECT_URL, redirectUri: redirectUri(),
    toolUrl: base ? `${base}/settings` : null,
  };
  try {
    const acct = await getConnectedAccount();
    if (!acct) return empty;
    const status: MailboxStatus = {
      ...empty,
      email: acct.email ?? null,
      connectedAt: acct.connected_at ?? null,
      // The token itself never leaves the server — only whether one exists.
      hasRefreshToken: !!acct.refresh_token,
    };
    if (!acct.email) return status;
    // Live check — a stored token can be revoked by Google at any time (invalid_grant).
    const health = await checkGmailConnection().catch((e) => ({
      ok: false, connected: true, error: e instanceof Error ? e.message : String(e), checkedAt: "",
    }));
    return {
      ...status,
      broken: !health.ok,
      error: health.ok ? null : health.error ?? "unknown error",
      invalidGrant: !health.ok && isInvalidGrant(health.error),
      checkedAt: health.checkedAt || null,
    };
  } catch {
    return empty;
  }
}
