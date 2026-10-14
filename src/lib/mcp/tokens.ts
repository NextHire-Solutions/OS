/*
 * The Claude connector's credentials (15 Oct): signed, stateless tokens.
 *
 * ---------------------------------------------------------------------------
 * WHY STATELESS
 *
 * Nothing is stored — no token table, no migration. Each token is a payload
 * and an HMAC, like the bs_sso cookie, and revocation rides on what the OS
 * already has: a token carries the user's `token_version`, so a password
 * change, a deactivation or SSO_SESSIONS_NOT_BEFORE ends Claude's access at
 * the next request, exactly as it ends a browser session.
 *
 * ---------------------------------------------------------------------------
 * ONE KEY PER KIND, NEVER THE COOKIE'S KEY
 *
 * Every kind is signed with its own key derived from AUTH_SECRET, and carries
 * its kind inside the payload as well. So an access token can never be
 * presented as a refresh token, an authorization code, a client id — or as a
 * bs_sso cookie: verifySso uses AUTH_SECRET itself, which signs none of these.
 * A token for Claude must not open the OS in a browser.
 */

export type TokenKind = "client" | "code" | "access" | "refresh";

/** How long each kind lives. A client registration does not expire. */
export const TTL_MS: Record<TokenKind, number | null> = {
  client: null,
  code: 5 * 60 * 1000,
  access: 60 * 60 * 1000,
  refresh: 30 * 24 * 60 * 60 * 1000,
};

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, kind: TokenKind, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${secret}\u0000brokerstaffer-os-mcp\u0000${kind}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))));
}

/** Constant time: a forged signature learns nothing from how fast it failed. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signToken(
  secret: string,
  kind: TokenKind,
  claims: Record<string, unknown>,
  now = Date.now(),
): Promise<string> {
  if (!secret) throw new Error("signToken: AUTH_SECRET is required");
  const ttl = TTL_MS[kind];
  const payload = { ...claims, typ: kind, iat: now, ...(ttl === null ? {} : { exp: now + ttl }) };
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, kind, body)}`;
}

/**
 * The payload of a valid, unexpired token of `kind`, or null. Signature first:
 * nothing in the payload is read until the HMAC checks out.
 */
export async function verifyToken<T extends Record<string, unknown>>(
  secret: string,
  kind: TokenKind,
  token: string | null | undefined,
  now = Date.now(),
): Promise<(T & { typ: TokenKind; iat: number; exp?: number }) | null> {
  if (!secret || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  if (!sameString(token.slice(dot + 1), await hmac(secret, kind, body))) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || payload.typ !== kind) return null;
  if (typeof payload.iat !== "number") return null;
  if (TTL_MS[kind] !== null && !(typeof payload.exp === "number" && payload.exp > now)) return null;
  return payload as T & { typ: TokenKind; iat: number; exp?: number };
}

/** SHA-256, base64url — PKCE's S256, and a short stable name for a client id. */
export async function sha256B64url(input: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input))));
}
