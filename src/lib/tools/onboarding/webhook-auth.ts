/*
 * How the inbound routes decide whether to answer.
 *
 * Two rules, kept apart because they fail in opposite directions:
 *
 *   · WEBHOOKS carry a shared token in the query string (the third parties
 *     cannot sign, except Typeform). The tool's rule: when the token is not
 *     configured the check is skipped — the webhook keeps working while the
 *     secret is being set up. Same here, so a Calendly booking is never dropped
 *     over a missing variable.
 *
 *   · CRON routes are ours to call and do real work on a schedule, so they FAIL
 *     CLOSED: no ONBOARDING_CRON_SECRET, no access. An unset secret meaning
 *     "open" would let anyone on the internet poll the mailbox.
 */

export function queryTokenAccepted(url: string, expected: string | undefined): boolean {
  if (!expected) return true;
  return new URL(url).searchParams.get("token") === expected;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type CronAuth = "ok" | "unconfigured" | "denied";

/** `Authorization: Bearer <ONBOARDING_CRON_SECRET>`. */
export function bearerAccepted(header: string | null, secret: string | undefined): CronAuth {
  if (!secret) return "unconfigured";
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m && safeEqual(m[1].trim(), secret) ? "ok" : "denied";
}
