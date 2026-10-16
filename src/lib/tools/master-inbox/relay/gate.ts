/*
 * The server-side switches for the brokerage relay. Read from the environment
 * at call time, never cached, so a test (or Railway) changing one is obeyed at
 * once.
 *
 * ---------------------------------------------------------------------------
 * A SEND NEEDS ALL OF THESE, AND EVERY DEFAULT IS "NO"
 *
 *   1. OS_BROKERAGE_RELAY_LIVE_SEND=1 on the OS service        (unset: no)
 *   2. POSTMARK_SERVER_TOKEN on the OS service                (unset: no)
 *   3. os_relay_settings.enabled            — Settings switch  (default: off)
 *   4. os_relay_settings.practice_mode = false                (default: practice)
 *   5. the brokerage's own switch (os_clients.relay_settings)  (default: off)
 *   6. in one-click mode (the default), a person pressing "Send to brokerage"
 *
 * 1 is checked twice: by the relay before it decides "live", and again inside
 * the Postmark transport before any request is built — so a caller that
 * skipped the first check still cannot send. Exactly "1", not truthy: the
 * reply agent's live gate uses the same rule, for the same reason.
 */

/** The environment, as these functions read it (a plain map, so tests can pass one). */
export type Env = Readonly<Record<string, string | undefined>>;

export const LIVE_SEND_ENV = "OS_BROKERAGE_RELAY_LIVE_SEND";
export const SWEEP_OFF_ENV = "OS_BROKERAGE_RELAY";
export const TOKEN_ENV = "POSTMARK_SERVER_TOKEN";
export const FROM_ENV = "OS_BROKERAGE_RELAY_FROM";
export const STREAM_ENV = "POSTMARK_MESSAGE_STREAM";

/** The domain the plan names — a separate address, never the normal @brokerstaffer.com mail. */
export const RELAY_DOMAIN = "leads.brokerstaffer.com";
/** Placeholder local part until the client picks one (open question). */
export const DEFAULT_FROM_ADDRESS = `agents@${RELAY_DOMAIN}`;

export function liveSendAllowed(env: Env = process.env): boolean {
  return env[LIVE_SEND_ENV]?.trim() === "1";
}

/** OS_BROKERAGE_RELAY=0 stops the sweep outright, whatever the database says. */
export function sweepSwitchedOff(env: Env = process.env): boolean {
  return env[SWEEP_OFF_ENV]?.trim() === "0";
}

export function postmarkToken(env: Env = process.env): string | null {
  const t = env[TOKEN_ENV]?.trim();
  return t ? t : null;
}

export function messageStream(env: Env = process.env): string {
  return env[STREAM_ENV]?.trim() || "outbound";
}

/** True for an address on the relay's own domain — the only kind it may send From. */
export function isRelayAddress(address: string | null | undefined): boolean {
  const a = (address ?? "").trim().toLowerCase();
  return /^[a-z0-9._%+-]+@/.test(a) && a.endsWith(`@${RELAY_DOMAIN}`);
}

/**
 * The From address. An override that is not on leads.brokerstaffer.com is
 * ignored rather than trusted: the plan promises the normal @brokerstaffer.com
 * mail and the cold-email inboxes are never used.
 */
export function fromAddress(env: Env = process.env): string {
  const v = env[FROM_ENV]?.trim().toLowerCase();
  return v && isRelayAddress(v) ? v : DEFAULT_FROM_ADDRESS;
}
