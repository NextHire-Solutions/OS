import { sessionsNotBefore } from "@/lib/bs-auth";

import { sha256B64url, signToken, TTL_MS, verifyToken } from "./tokens.ts";

/*
 * Signing Claude in to BrokerStaffer OS (15 Oct) — OAuth 2.1 as the MCP
 * authorization spec asks for it: discovery documents, dynamic client
 * registration, authorization code with PKCE (S256 only), refresh tokens.
 *
 * The person signs in with their ordinary OS login and presses Allow on
 * /oauth/authorize; nothing about their password ever reaches Claude. Every
 * rule is here, as plain functions, so it is tested without a server; the
 * routes under app/api/oauth and app/.well-known only wire them up.
 *
 * Who may connect, and what they get, is decided at every step by a
 * `UserCheck` the routes supply: the live user record and the admin list, so
 * revoking someone in Team access ends their connector at the next request.
 */

/** The one scope: read. The connector has no other. */
export const SCOPE = "os.read";

export function publicOrigin(): string {
  return (process.env.OS_PUBLIC_URL ?? "https://os.brokerstaffer.com").replace(/\/+$/, "");
}

/** The protected resource — the MCP endpoint. Tokens are minted for it and only it. */
export function resourceUrl(): string {
  return `${publicOrigin()}/api/mcp`;
}

export function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [publicOrigin()],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "BrokerStaffer OS",
  };
}

export function authorizationServerMetadata() {
  const o = publicOrigin();
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/api/oauth/token`,
    registration_endpoint: `${o}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  };
}

/*
 * Where a sign-in may send its code. Claude's own callbacks, and loopback for
 * Claude Code and other local clients (RFC 8252). Nothing else: this server
 * exists to connect Claude, and an open redirect list would let any site wrap
 * an OS sign-in around its own page. MCP_EXTRA_REDIRECT_URIS (comma-separated,
 * exact) adds one without a deploy.
 */
const CLAUDE_CALLBACKS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

export function isAllowedRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  const extra = (process.env.MCP_EXTRA_REDIRECT_URIS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (CLAUDE_CALLBACKS.includes(uri) || extra.includes(uri)) return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}

/** PKCE, S256: the verifier hashes to the challenge the authorization was bound to. */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return (await sha256B64url(verifier)) === challenge;
}

/* --------------------------------------------------- dynamic registration --- */

interface ClientClaims extends Record<string, unknown> {
  ru: string[];
  name: string;
}

export interface Result {
  status: number;
  body: Record<string, unknown>;
}

const oauthError = (status: number, error: string, description: string): Result => ({
  status,
  body: { error, error_description: description },
});

/*
 * RFC 7591. Stateless like everything else: the client id IS the signed
 * registration (its redirect URIs and name), so nothing is stored and a
 * client id cannot be edited to add a redirect.
 */
export async function registerClient(secret: string, input: unknown, now = Date.now()): Promise<Result> {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length || uris.length > 10) {
    return oauthError(400, "invalid_redirect_uri", "Give between one and ten redirect_uris.");
  }
  const refused = uris.filter((u) => !isAllowedRedirect(u));
  if (refused.length) {
    return oauthError(400, "invalid_redirect_uri", `Not an address this server signs in to: ${refused.join(", ")}`);
  }
  const name = (typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim() : "Claude").slice(0, 80);
  const clientId = await signToken(secret, "client", { ru: uris, name } satisfies ClientClaims, now);
  return {
    status: 201,
    body: {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public clients with PKCE. A secret is never issued, so none can leak.
      token_endpoint_auth_method: "none",
    },
  };
}

/* ---------------------------------------------------------- authorization --- */

export interface AuthorizeRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string;
}

/*
 * Checks the /oauth/authorize parameters. Until the client and its redirect
 * URI are known to be good, an error is SHOWN, never redirected — sending an
 * error to an unverified address is the open redirect this guards against.
 */
export async function checkAuthorizeRequest(
  secret: string,
  get: (name: string) => string | null,
): Promise<
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; redirect: null; message: string }
  | { ok: false; redirect: string; message: string }
> {
  const clientId = get("client_id") ?? "";
  const client = await verifyToken<ClientClaims>(secret, "client", clientId);
  if (!client || !Array.isArray(client.ru)) {
    return { ok: false, redirect: null, message: "This sign-in link is not from a registered client. Start again from Claude." };
  }
  const requested = get("redirect_uri");
  const redirectUri = requested ?? (client.ru.length === 1 ? client.ru[0] : "");
  if (!redirectUri || !client.ru.includes(redirectUri) || !isAllowedRedirect(redirectUri)) {
    return { ok: false, redirect: null, message: "This sign-in link has an address it is not allowed to return to. Start again from Claude." };
  }

  const state = get("state");
  const back = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    return { ok: false as const, redirect: u.toString(), message: description };
  };

  if (get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || get("code_challenge_method") !== "S256") {
    return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  const resource = get("resource");
  if (resource && resource.replace(/\/+$/, "") !== resourceUrl() && resource.replace(/\/+$/, "") !== publicOrigin()) {
    return back("invalid_target", `This server only grants access to ${resourceUrl()}.`);
  }
  return {
    ok: true,
    request: { clientId, clientName: String(client.name ?? "Claude"), redirectUri, codeChallenge: challenge, state, scope: SCOPE },
  };
}

/** The address Allow sends the browser to: the client's callback with a five-minute code. */
export async function approve(secret: string, request: AuthorizeRequest, email: string, now = Date.now()): Promise<string> {
  const code = await signToken(
    secret,
    "code",
    { cid: await sha256B64url(request.clientId), ru: request.redirectUri, cc: request.codeChallenge, email, scope: request.scope },
    now,
  );
  const u = new URL(request.redirectUri);
  u.searchParams.set("code", code);
  if (request.state) u.searchParams.set("state", request.state);
  u.searchParams.set("iss", publicOrigin());
  return u.toString();
}

export function deny(request: AuthorizeRequest): string {
  const u = new URL(request.redirectUri);
  u.searchParams.set("error", "access_denied");
  u.searchParams.set("error_description", "The connection was not allowed.");
  if (request.state) u.searchParams.set("state", request.state);
  return u.toString();
}

/* ------------------------------------------------------------------ tokens --- */

/**
 * The live answer to "may this person use the connector": their token version
 * when they may, or why not. Supplied by the routes (user record + admin list).
 */
export type UserCheck = (email: string) => Promise<{ ok: true; ver: number } | { ok: false; reason: string }>;

interface CodeClaims extends Record<string, unknown> {
  cid: string;
  ru: string;
  cc: string;
  email: string;
  scope: string;
}
interface GrantClaims extends Record<string, unknown> {
  email: string;
  ver: number;
  cid: string;
  scope: string;
  aud?: string;
}

async function issue(secret: string, email: string, ver: number, cid: string, now: number): Promise<Result> {
  const access = await signToken(secret, "access", { email, ver, cid, scope: SCOPE, aud: resourceUrl() } satisfies GrantClaims, now);
  const refresh = await signToken(secret, "refresh", { email, ver, cid, scope: SCOPE } satisfies GrantClaims, now);
  return {
    status: 200,
    body: {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor((TTL_MS.access ?? 0) / 1000),
      refresh_token: refresh,
      scope: SCOPE,
    },
  };
}

/** Before "log everyone out" (SSO_SESSIONS_NOT_BEFORE)? Then the connector is logged out too. */
function beforeCutoff(iat: number): boolean {
  const cutoff = sessionsNotBefore();
  return cutoff !== null && iat < cutoff;
}

/** POST /api/oauth/token, both grants. `form` is the request body as fields. */
export async function exchange(
  secret: string,
  form: (name: string) => string | null,
  userCheck: UserCheck,
  now = Date.now(),
): Promise<Result> {
  const grant = form("grant_type");
  const clientId = form("client_id");

  if (grant === "authorization_code") {
    const code = await verifyToken<CodeClaims>(secret, "code", form("code"), now);
    if (!code) return oauthError(400, "invalid_grant", "The code is invalid or has expired. Sign in again from Claude.");
    if (!clientId || (await sha256B64url(clientId)) !== code.cid) {
      return oauthError(400, "invalid_grant", "The code was issued to a different client.");
    }
    if (form("redirect_uri") !== null && form("redirect_uri") !== code.ru) {
      return oauthError(400, "invalid_grant", "redirect_uri does not match the authorization.");
    }
    if (!(await pkceMatches(form("code_verifier") ?? "", code.cc))) {
      return oauthError(400, "invalid_grant", "code_verifier does not match the code_challenge.");
    }
    const user = await userCheck(code.email);
    if (!user.ok) return oauthError(400, "invalid_grant", user.reason);
    return issue(secret, code.email, user.ver, code.cid, now);
  }

  if (grant === "refresh_token") {
    const refresh = await verifyToken<GrantClaims>(secret, "refresh", form("refresh_token"), now);
    if (!refresh || beforeCutoff(refresh.iat)) {
      return oauthError(400, "invalid_grant", "The refresh token is invalid or has expired. Reconnect from Claude.");
    }
    if (clientId && (await sha256B64url(clientId)) !== refresh.cid) {
      return oauthError(400, "invalid_grant", "The refresh token was issued to a different client.");
    }
    const user = await userCheck(refresh.email);
    if (!user.ok) return oauthError(400, "invalid_grant", user.reason);
    if (user.ver !== refresh.ver) {
      return oauthError(400, "invalid_grant", "Your OS sign-in changed (a new password, or a sign-out everywhere). Reconnect from Claude.");
    }
    return issue(secret, refresh.email, user.ver, refresh.cid, now);
  }

  return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
}

/*
 * Every MCP request. The bearer must be an access token for THIS resource,
 * minted after the last "log everyone out", for a user who may still connect,
 * at the token version they still hold.
 */
export async function authenticate(
  secret: string,
  authorization: string | null,
  userCheck: UserCheck,
  now = Date.now(),
): Promise<{ ok: true; email: string } | { ok: false; status: 401 | 403; error: string; description: string }> {
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
  if (!bearer) return { ok: false, status: 401, error: "invalid_token", description: "Sign in to BrokerStaffer OS to use this connector." };
  const access = await verifyToken<GrantClaims>(secret, "access", bearer, now);
  if (!access || access.aud !== resourceUrl() || beforeCutoff(access.iat)) {
    return { ok: false, status: 401, error: "invalid_token", description: "The sign-in has expired. Reconnect from Claude." };
  }
  const user = await userCheck(access.email);
  if (!user.ok) return { ok: false, status: 403, error: "insufficient_scope", description: user.reason };
  if (user.ver !== access.ver) {
    return { ok: false, status: 401, error: "invalid_token", description: "Your OS sign-in changed. Reconnect from Claude." };
  }
  return { ok: true, email: access.email };
}

/**
 * The header a 401 carries, so a client can find out how to sign in (RFC 9728).
 * A request that sent no token gets no error attribute (RFC 6750 §3.1).
 */
export function wwwAuthenticate(error: string | null, description = ""): string {
  const meta = `Bearer resource_metadata="${publicOrigin()}/.well-known/oauth-protected-resource/api/mcp"`;
  return error ? `${meta}, error="${error}", error_description="${description.replace(/"/g, "'")}"` : meta;
}
