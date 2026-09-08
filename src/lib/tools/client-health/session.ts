import "server-only";

import { NotConfiguredError } from "@/lib/env";

/*
 * Signing in to Client Health as the workspace.
 *
 * ---------------------------------------------------------------------------
 * WHY MINT ITS COOKIE RATHER THAN CHANGE THE TOOL
 *
 * Reads come straight from Client Health's database, but WRITES must go
 * through its own API — that is where its validation lives, and where its sync
 * worker's assumptions are enforced. Writing to its tables directly would work
 * right up until it silently didn't.
 *
 * Its API authenticates a person by a `bs_auth` cookie, and only that path
 * permits POST, PATCH and DELETE: the `x-admin-token` route is deliberately
 * narrowed to GET /api/clients so a read token can never write.
 *
 * So the workspace derives the same cookie the tool's own login produces —
 * HMAC-SHA256 of a fixed message under the dashboard password, exactly as
 * `expectedCookieValue` in the tool computes it. Copied, not reimplemented: if
 * this ever disagreed the writes would 401 rather than corrupt anything, but
 * copying keeps it honest.
 *
 * The point of doing it this way is that the live tool needs no change at all.
 * No new endpoint, no new token, no deploy. Its existing auth is simply used
 * as intended.
 *
 * The password lives only in Railway. It is never sent to the browser — every
 * write is proxied through this app's own API routes, which the workspace's
 * sign-in already guards.
 */

const AUTH_MESSAGE = "bs-dashboard-authed";

let cached: { password: string; value: string } | null = null;

/** The `bs_auth` cookie value Client Health's own login would set. */
export async function clientHealthAuthCookie(): Promise<string> {
  const password = process.env.CLIENT_HEALTH_DASHBOARD_PASSWORD;
  if (!password) throw new NotConfiguredError("CLIENT_HEALTH_DASHBOARD_PASSWORD");

  // The derivation is deterministic, so it is computed once per password.
  if (cached && cached.password === password) return cached.value;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(AUTH_MESSAGE));

  const bytes = new Uint8Array(sig);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const value = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  cached = { password, value };
  return value;
}

/**
 * Calls Client Health's own API as a signed-in person.
 *
 * Every write the workspace makes goes through here, so there is exactly one
 * place that knows how to authenticate to that tool.
 */
export async function callClientHealth(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const base = process.env.CLIENT_HEALTH_URL;
  if (!base) throw new NotConfiguredError("CLIENT_HEALTH_URL");

  const { timeoutMs = 120_000, headers, ...rest } = init;

  // A full sync walks every campaign on two platforms and is genuinely slow;
  // the default fetch timeout would abandon it halfway and report a failure
  // for something that actually succeeded.
  const abort = AbortSignal.timeout(timeoutMs);

  return fetch(`${base.replace(/\/$/, "")}${path}`, {
    ...rest,
    signal: abort,
    cache: "no-store",
    headers: {
      ...headers,
      cookie: `bs_auth=${await clientHealthAuthCookie()}`,
    },
  });
}
