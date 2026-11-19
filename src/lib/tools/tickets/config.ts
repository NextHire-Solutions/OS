import { publicOrigin } from "@/lib/mcp/oauth";

import type { OAuthConfig } from "./gmail-api";

/*
 * TICKETS — which Google OAuth client connects the team's Gmail. ITS OWN, never the Onboarding app's (review,
 * 20 Nov): on the Onboarding client Eddy already granted gmail.send + gmail.modify, so a Tickets token could carry
 * them, and disconnecting Tickets (Google's revoke) would end the Onboarding app's Gmail connection too.
 *
 * TICKETS_GOOGLE_CLIENT_ID / TICKETS_GOOGLE_CLIENT_SECRET: an OAuth client (type "Web application", consent screen
 * "Internal") whose authorised redirect URI is the callback below. Until both are set, Connect says so.
 */

export const CALLBACK_PATH = "/api/tools/tickets/google/callback";

export function oauthConfig(): OAuthConfig | null {
  const clientId = process.env.TICKETS_GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.TICKETS_GOOGLE_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: process.env.TICKETS_GOOGLE_REDIRECT_URI || `${publicOrigin()}${CALLBACK_PATH}` };
}

/** The key Gmail tokens are sealed with is set (OS_TICKETS_TOKEN_KEY, 32+ characters). */
export function tokenKeySet(): boolean {
  return (process.env.OS_TICKETS_TOKEN_KEY ?? "").length >= 32;
}

/** The sync runs on Railway unless switched off with OS_TICKETS_SYNC=0; it does nothing until a mailbox is connected. */
export function syncEnabled(): boolean {
  return process.env.OS_TICKETS_SYNC !== "0";
}
