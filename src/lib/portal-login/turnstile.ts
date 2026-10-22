/*
 * The bot check on the client sign-in (Cloudflare Turnstile, 22 Oct). The
 * client created the Cloudflare account and sent the keys; the site key is
 * public (it is drawn into the page), the secret stays on the server.
 *
 * ON only when both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set (on
 * Railway, at deploy). Then "Send link to log in" and the code form each need
 * a token the server checks with Cloudflare before it does anything — and a
 * check that cannot be completed (Cloudflare unreachable, a slow answer) is a
 * refusal: fail closed. The refusal is the same for every address, so it says
 * nothing about who is on a list.
 */

export const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/* Cloudflare's published test secrets (1x… passes, 2x… fails, 3x… "already spent") — for local tests only. */
const TEST_SECRET = /^[123]x0{31}AA$/;

/** What a form names its check — Cloudflare returns it, so a token from one form can't be used on the other. */
export type TurnstileAction = "signin-request" | "signin-code";

type Env = Record<string, string | undefined>;

export function turnstileSiteKey(env: Env = process.env): string | null {
  const site = env.TURNSTILE_SITE_KEY?.trim();
  return site && env.TURNSTILE_SECRET_KEY?.trim() ? site : null;
}

export type HumanCheck = { ok: true; skipped?: true } | { ok: false; reason: "missing" | "failed" | "unreachable" };

/** The one answer a person sees when the check does not pass. */
export const CHECK_REFUSED = "Please complete the security check, then try again.";

export async function verifyTurnstile(
  token: unknown,
  ip: string | null,
  action: TurnstileAction,
  deps: { fetch?: typeof fetch; env?: Env } = {},
): Promise<HumanCheck> {
  const env = deps.env ?? process.env;
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret || !env.TURNSTILE_SITE_KEY?.trim()) return { ok: true, skipped: true };
  if (typeof token !== "string" || !token || token.length > 2048) return { ok: false, reason: "missing" };
  try {
    const res = await (deps.fetch ?? fetch)(SITEVERIFY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(8_000),
    });
    const j = (await res.json().catch(() => null)) as { success?: boolean; action?: string; "error-codes"?: string[] } | null;
    if (!res.ok || !j) return { ok: false, reason: "unreachable" };
    if (j.success !== true) {
      console.warn(JSON.stringify({ tag: "[portal-signin] check refused", codes: (j["error-codes"] ?? []).slice(0, 5) }));
      return { ok: false, reason: "failed" };
    }
    // A token made for the other form is not this form's. Cloudflare's documented test secrets answer action "test" — only for those is the action not compared.
    if (j.action && j.action !== action && !TEST_SECRET.test(secret)) return { ok: false, reason: "failed" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
