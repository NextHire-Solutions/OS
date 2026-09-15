import "server-only";

import { getOnboardingDb } from "./db";
import { appBaseUrl, onboardingEnv } from "./env";
import { buildConsentUrl, GMAIL_SCOPES } from "./gmail-pure";

/*
 * Google OAuth2 (authorization-code) for the single connected mailbox — no
 * external deps. The tool's `lib/google-oauth.ts`. The user clicks Connect,
 * approves once, we keep a refresh token in `orch_email_account` and mint
 * access tokens on demand.
 *
 * Env (ONBOARDING_ prefix): GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
 * and optionally GOOGLE_OAUTH_REDIRECT_URI. The redirect URI registered with
 * Google for the OS is
 *   https://os.brokerstaffer.com/api/tools/onboarding/auth/google/callback
 * which is what the default below produces from APP_BASE_URL.
 *
 * What the token is used for HERE: reading replies (gmail-replies.ts) and the
 * connection check (gmail-health.ts). Sending is switched off in the OS.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export function redirectUri(): string {
  return onboardingEnv("GOOGLE_OAUTH_REDIRECT_URI") || `${appBaseUrl()}/api/tools/onboarding/auth/google/callback`;
}

export function oauthConfigured(): boolean {
  return !!onboardingEnv("GOOGLE_OAUTH_CLIENT_ID") && !!onboardingEnv("GOOGLE_OAUTH_CLIENT_SECRET");
}

export function consentUrl(state: string): string {
  const clientId = onboardingEnv("GOOGLE_OAUTH_CLIENT_ID");
  if (!clientId) throw new Error("ONBOARDING_GOOGLE_OAUTH_CLIENT_ID not set");
  return buildConsentUrl(clientId, redirectUri(), state);
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number; scope?: string };

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${JSON.stringify(json)}`);
  return json as TokenResponse;
}

const credentials = () => {
  const id = onboardingEnv("GOOGLE_OAUTH_CLIENT_ID"), secret = onboardingEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!id || !secret) throw new Error("ONBOARDING_GOOGLE_OAUTH_CLIENT_ID / _SECRET not set");
  return { client_id: id, client_secret: secret };
};

const NIL = "00000000-0000-0000-0000-000000000000";

/** Exchange the auth code for tokens + the account email, and persist. */
export async function connectFromCode(code: string): Promise<{ email: string }> {
  const t = await tokenRequest({ code, ...credentials(), redirect_uri: redirectUri(), grant_type: "authorization_code" });

  // Which mailbox did they connect? Read it from the userinfo endpoint.
  const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${t.access_token}` }, cache: "no-store",
  }).then((r) => r.json() as Promise<{ email?: string }>);
  const email = ui.email as string;

  // Single-account model: keep exactly one row.
  const db = getOnboardingDb();
  await db.from("orch_email_account").delete().neq("id", NIL);
  const { error } = await db.from("orch_email_account").insert({
    provider: "google",
    email,
    refresh_token: t.refresh_token ?? null,
    access_token: t.access_token,
    token_expiry: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(),
    scope: t.scope ?? GMAIL_SCOPES.join(" "),
  });
  if (error) throw new Error(error.message);
  return { email };
}

export type ConnectedAccount = {
  id: string; email: string; refresh_token: string | null; access_token: string | null;
  token_expiry: string | null; connected_at: string | null;
};

export async function getConnectedAccount(): Promise<ConnectedAccount | null> {
  const { data } = await getOnboardingDb()
    .from("orch_email_account").select("*").order("connected_at", { ascending: false }).limit(1).maybeSingle();
  return (data ?? null) as ConnectedAccount | null;
}

/** Valid access token for the connected account, refreshing if expired. Null if not connected. */
export async function getAccessToken(): Promise<{ token: string; from: string } | null> {
  const acct = await getConnectedAccount();
  if (!acct?.refresh_token) return null;

  if (acct.access_token && acct.token_expiry && new Date(acct.token_expiry) > new Date()) {
    return { token: acct.access_token, from: acct.email };
  }
  const t = await tokenRequest({ ...credentials(), refresh_token: acct.refresh_token, grant_type: "refresh_token" });
  await getOnboardingDb().from("orch_email_account").update({
    access_token: t.access_token,
    token_expiry: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", acct.id);
  return { token: t.access_token, from: acct.email };
}

/** Forget the connected mailbox. The tool's `disconnectGoogle` server action. */
export async function disconnectGoogle(): Promise<void> {
  const { error } = await getOnboardingDb().from("orch_email_account").delete().neq("id", NIL);
  if (error) throw new Error(error.message);
}
