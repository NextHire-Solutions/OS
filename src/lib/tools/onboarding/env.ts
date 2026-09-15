import { optionalEnv } from "@/lib/env";

/*
 * The orchestrator's environment, as the workspace holds it.
 *
 * Every variable the deployed tool reads unprefixed (BISON_API_KEY,
 * SLACK_BOT_TOKEN, GOOGLE_OAUTH_CLIENT_ID, …) is present in the OS under an
 * ONBOARDING_ prefix, the same way Master Inbox's live under MASTER_INBOX_.
 * Five tools share one environment; an unprefixed SLACK_BOT_TOKEN would be
 * whichever tool set it last.
 *
 * Read through `optionalEnv`, which is what the rest of this folder already
 * uses (`ONBOARDING_URL`, `ONBOARDING_STRIPE_MODE`): trimmed, and "" counts as
 * unset.
 */

export const ONBOARDING_ENV_PREFIX = "ONBOARDING_";

export function onboardingEnv(name: string): string | undefined {
  return optionalEnv(ONBOARDING_ENV_PREFIX + name);
}

/**
 * Where this workspace is reachable — the origin Google redirects back to and
 * the one Slack alerts link to. Production is https://os.brokerstaffer.com.
 */
export function appBaseUrl(): string {
  return (
    optionalEnv("APP_BASE_URL") ??
    onboardingEnv("APP_BASE_URL") ??
    "https://os.brokerstaffer.com"
  ).replace(/\/+$/, "");
}

/**
 * Positive number from an env var, falling back to `def` on blank/garbage — a
 * Railway typo must never become 0 (instant sends) or NaN (feature silently
 * off). An explicit "0" is honoured. Ported from the tool's `lib/format.ts`.
 */
export function envNumber(name: string, def: number): number {
  const raw = onboardingEnv(name);
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
