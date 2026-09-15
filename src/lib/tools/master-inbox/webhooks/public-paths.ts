/*
 * Where the providers deliver mail to the OS.
 *
 * ---------------------------------------------------------------------------
 * The tool received webhooks at `/api/webhooks/<provider>` on its own host.
 * The OS serves the same receivers under its tool prefix, on its own host:
 *
 *   https://os.brokerstaffer.com/api/tools/master-inbox/webhooks/instantly
 *   https://os.brokerstaffer.com/api/tools/master-inbox/webhooks/emailbison
 *
 * These paths are the ONE thing three separate places must agree on — the
 * route files, the registration endpoints that tell Instantly and EmailBison
 * where to POST, and the proxy allowlist that lets a session-less request
 * reach the handler at all. So they are declared once, here, and everything
 * else derives from them.
 *
 * ---------------------------------------------------------------------------
 * THE PROXY
 *
 * `src/proxy.ts` answers 401 to every `/api/*` request without a signed-in
 * session. A provider has no session, and sends no `x-admin-token` either, so
 * the existing TOKEN_ROUTES escape hatch does not apply. Each path in
 * `PROXY_ALLOWLIST` must be let through by PATH; the handler behind it then
 * enforces its own secret (webhooks/verify.ts). That edit is deliberately not
 * made from this module — the proxy is the front door of the whole workspace,
 * and changing it is a separate, reviewed step.
 */

/** The OS's public origin. No env var exists for it; the portal host is a constant too. */
export const OS_PUBLIC_URL = "https://os.brokerstaffer.com";

const PREFIX = "/api/tools/master-inbox";

export const WEBHOOK_PATHS = {
  instantly: `${PREFIX}/webhooks/instantly`,
  emailbison: `${PREFIX}/webhooks/emailbison`,
  register: `${PREFIX}/webhooks/register`,
} as const;

export const CRON_PATHS = {
  syncExternalIntros: `${PREFIX}/cron/sync-external-intros`,
} as const;

export const ADMIN_PATHS = {
  instantlyRegisterWebhook: `${PREFIX}/admin/instantly/register-webhook`,
} as const;

/**
 * Every path that must be reachable WITHOUT a workspace session. Exact paths,
 * no prefixes — the same shape as the proxy's TOKEN_ROUTES.
 *
 * The two receivers are called by the providers. The other three are called
 * by an operator or a scheduler with a secret, and are listed so the switch
 * from the tool can be driven with curl alone.
 */
export const PROXY_ALLOWLIST: readonly string[] = [
  WEBHOOK_PATHS.instantly,
  WEBHOOK_PATHS.emailbison,
  WEBHOOK_PATHS.register,
  CRON_PATHS.syncExternalIntros,
  ADMIN_PATHS.instantlyRegisterWebhook,
];

/** `base` with any trailing slash removed, so `${base}${path}` is always right. */
export function normalizeBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * The URL a provider is told to POST to.
 *
 * Neither provider signs its payloads, so the shared secret rides on the URL
 * as `?token=` — the tool did this for Instantly, and the port does it for
 * EmailBison too because the receivers now REQUIRE the secret (see
 * webhooks/verify.ts). A registration without it would be rejected on every
 * delivery.
 */
export function receiverUrl(base: string, path: string, secret: string): string {
  return `${normalizeBase(base)}${path}?token=${encodeURIComponent(secret)}`;
}

/**
 * Whether a registered webhook URL points at one of OUR receivers.
 *
 * Matched on the PATH, not the full URL, so rotating the secret does not leave
 * orphans behind — the tool's Instantly registration matched this way for the
 * same reason. `base` narrows it to one deployment.
 */
export function pointsAtReceiver(hookUrl: string, base: string, path: string): boolean {
  return hookUrl.startsWith(`${normalizeBase(base)}${path}`);
}
