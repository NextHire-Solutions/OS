import { publicOrigin } from "@/lib/mcp/oauth";

import type { OAuthConfig } from "./gmail-api";

/*
 * TICKETS — which Google OAuth client connects the team's Gmail.
 *
 * The OS already holds the Onboarding app's client (ONBOARDING_GOOGLE_OAUTH_CLIENT_ID / _SECRET, Google Cloud
 * project 675296613069 — the one Eddy's mailbox was connected with on 2 Jul). TICKETS_GOOGLE_CLIENT_ID / _SECRET
 * take precedence if a separate client is ever made. Google must list the callback below as an authorised
 * redirect URI for that client: until someone adds it, Google answers "redirect_uri_mismatch" (checked 20 Nov:
 * only the orchestrator's Railway address is registered).
 */

export const CALLBACK_PATH = "/api/tools/tickets/google/callback";

export function oauthConfig(): OAuthConfig | null {
  const clientId = process.env.TICKETS_GOOGLE_CLIENT_ID || process.env.ONBOARDING_GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = process.env.TICKETS_GOOGLE_CLIENT_SECRET || process.env.ONBOARDING_GOOGLE_OAUTH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: process.env.TICKETS_GOOGLE_REDIRECT_URI || `${publicOrigin()}${CALLBACK_PATH}` };
}

/** The sync runs on Railway unless switched off with OS_TICKETS_SYNC=0; it does nothing until a mailbox is connected. */
export function syncEnabled(): boolean {
  return process.env.OS_TICKETS_SYNC !== "0";
}
