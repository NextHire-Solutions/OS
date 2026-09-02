import { hmacHex } from "@/lib/auth/session";

/*
 * Mints a session token the Analytics app will accept.
 *
 * A deliberate reimplementation of `createSessionToken` from
 *   Corofy/Analytics Dashboard/src/lib/auth.ts
 * and it must stay byte-compatible with it:
 *   payload   = base64url(email) "." expiresAt
 *   signature = hex HMAC-SHA256(ANALYTICS_AUTH_SECRET, payload)
 *
 * Why mint instead of asking for a token: Analytics has no bearer escape hatch
 * on /api/analytics/*, no CORS, and no session store — verification is a pure
 * function of (secret, email, expiry). So we can produce a valid credential
 * with zero changes to that app and nothing to rotate or persist.
 *
 * Minted per request (an HMAC costs microseconds) with a deliberately short
 * TTL: we are a machine making one call, not a human holding a 30-day session.
 *
 * Caveat worth knowing before someone "fixes" it: the upstream's
 * verifySessionToken does NOT re-check AUTH_USERS membership, so any email
 * verifies. ANALYTICS_SERVICE_EMAIL should still be added to that app's
 * AUTH_USERS so this keeps working if it ever starts checking.
 */

const TTL_MS = 10 * 60_000;

const encoder = new TextEncoder();

function base64UrlEncode(input: string): string {
  const bytes = encoder.encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function mintAnalyticsSession(
  secret: string,
  email: string,
  now = Date.now(),
): Promise<string> {
  const expiresAt = now + TTL_MS;
  const payload = `${base64UrlEncode(email)}.${expiresAt}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}
