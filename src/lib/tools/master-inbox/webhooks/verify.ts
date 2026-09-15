/*
 * Shared-secret checks for the session-less endpoints.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE TOOL DID, AND THE ONE THING THE PORT CHANGES
 *
 * Neither Instantly nor EmailBison signs its webhooks. The tool's receivers
 * therefore compared a shared secret carried as `?token=` (or the
 * `x-webhook-token` header) against an env var — and when that env var was
 * UNSET, they accepted every request. That was a bootstrap convenience on a
 * host nothing else could reach.
 *
 * The OS is different: these paths are opened in the proxy by name, so an
 * unset secret would mean an open write path into the inbox from the public
 * internet. So the port fails CLOSED. An unset secret is a 503 with a message
 * naming the variable — "we are not configured to receive yet" — rather than
 * a 401, which would read as "your token is wrong" to an operator who has not
 * set one. A wrong token is still 401, exactly as before.
 *
 * ---------------------------------------------------------------------------
 * PURE, SO IT CAN BE TESTED
 *
 * These take a `Request` and return a verdict; the routes turn the verdict
 * into a response. `next/server` cannot be loaded by `node --test`, so the
 * decision lives here where it can be. The comparison is constant-time via
 * bs-auth's `safeEqual`, imported relatively for the same reason
 * `tool-paths.ts` does.
 */

import { safeEqual } from "../../../bs-auth.ts";

export type Verdict =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

/**
 * The token the caller presented. `?token=` first, then the header, matching
 * the tool's precedence so an existing registration keeps working.
 */
export function suppliedToken(request: Request, header: string): string | null {
  const url = new URL(request.url);
  return url.searchParams.get("token") ?? request.headers.get(header);
}

/**
 * Verify a shared secret carried as `?token=` or in `header`.
 *
 * `varName` is the (namespaced) env var, named in the 503 so the operator
 * knows exactly what to set.
 */
export function verifySharedSecret(
  request: Request,
  expected: string | undefined,
  opts: { header: string; varName: string },
): Verdict {
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: `${opts.varName} is not set — this endpoint refuses every request until it is`,
    };
  }
  const supplied = suppliedToken(request, opts.header);
  if (supplied === null || !safeEqual(supplied, expected)) {
    return { ok: false, status: 401, error: "invalid token" };
  }
  return { ok: true };
}

/**
 * Verify an `Authorization: Bearer <secret>` header — the cron endpoint's
 * contract, the same shape as ANALYTICS_CRON_SECRET.
 */
export function verifyBearer(
  request: Request,
  expected: string | undefined,
  opts: { varName: string },
): Verdict {
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: `${opts.varName} is not set — this endpoint refuses every request until it is`,
    };
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !safeEqual(match[1], expected)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}
