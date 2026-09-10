import "server-only";

import { NotConfiguredError } from "@/lib/env";

/*
 * Signing in to Client Health as the workspace.
 *
 * ---------------------------------------------------------------------------
 * WHAT STILL GOES THROUGH THE LIVE TOOL, AND WHY ONLY THIS
 *
 * One thing: "Sync now". Client edits, pauses, churns and deletes used to come
 * through here too; they now write to Client Health's database directly, from
 * `clientWrites.ts`, because the tool is being switched off and a proxy dies
 * with it.
 *
 * The sync is the exception because it is not a write the OS is qualified to
 * make. `runSync()` walks Instantly and EmailBison, reconciles campaigns and
 * pulls introductions from Corofy; a second implementation of that would drift,
 * and the way anyone would find out is two dashboards disagreeing about a
 * client's numbers. So the OS presses the tool's own button instead.
 *
 * That means this file survives exactly as long as the sync worker does, and no
 * longer. When the tool goes, the sync worker has to move — not this.
 *
 * The tool authenticates a person by a `bs_auth` cookie, and only that path
 * permits POST: its `x-admin-token` route is deliberately narrowed to
 * GET /api/clients so a read token can never trigger anything. So the workspace
 * derives the same cookie the tool's own login produces — HMAC-SHA256 of a
 * fixed message under the dashboard password, exactly as `expectedCookieValue`
 * in the tool computes it. Copied, not reimplemented: if this ever disagreed
 * the call would 401 rather than misfire, but copying keeps it honest.
 *
 * The password lives only in Railway. It is never sent to the browser — the
 * call is made from this app's own API route, which the workspace's sign-in
 * already guards.
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
 * One caller: `POST /api/tools/client-health/sync`. Kept general because there
 * is exactly one place that should know how to authenticate to that tool, and
 * one place is easier to delete than five.
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
