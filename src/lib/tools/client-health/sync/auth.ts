import { hasGrant, readSsoCookie, verifySso } from "@/lib/bs-auth";
import { optionalEnv } from "@/lib/env";

/*
 * Who may start a sync.
 *
 * The tool's POST /api/sync/run took an optional shared secret: if SYNC_SECRET
 * was set, `x-sync-secret` (or `?secret=`) had to match; if it was unset,
 * anyone could POST. That was survivable behind the tool's own login. Here it
 * fails CLOSED — an unset CLIENT_HEALTH_SYNC_SECRET means the secret path is
 * simply not available, never that it is open — and the workspace session is
 * the second way in, so the Sync button works with no secret configured at all.
 *
 * The session is verified here rather than trusted from the proxy, because the
 * proxy's job is to keep unauthenticated traffic out of /api/tools/* and this
 * route additionally wants to accept a secret-bearing caller the proxy would
 * otherwise bounce. Checking both in one place keeps the rule readable: a
 * person with the `clients` grant, or a machine with the secret.
 */

export type SyncCaller = "session" | "secret";

/** Constant-time compare — `===` leaks how much of a guess was correct. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pure: does the supplied secret match the configured one? Unset → never. */
export function secretMatches(
  supplied: string | null | undefined,
  configured: string | undefined = optionalEnv("CLIENT_HEALTH_SYNC_SECRET"),
): boolean {
  if (!configured || !supplied) return false;
  return safeEqual(supplied, configured);
}

export async function authorizeSync(request: Request): Promise<SyncCaller | null> {
  const url = new URL(request.url);
  const supplied = request.headers.get("x-sync-secret") ?? url.searchParams.get("secret");
  if (supplied !== null && secretMatches(supplied)) return "secret";

  const secret = optionalEnv("AUTH_SECRET");
  if (!secret) return null;
  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  return hasGrant(session, "clients") ? "session" : null;
}
