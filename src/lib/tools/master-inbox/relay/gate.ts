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
 *   7. while OS_BROKERAGE_RELAY_LIVE_ONLY is set: every recipient on one of
 *      its domains (the pilot fence — see below)
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
export const LIVE_ONLY_ENV = "OS_BROKERAGE_RELAY_LIVE_ONLY";

/** The domain the plan names — a separate address, never the normal @brokerstaffer.com mail. */
export const RELAY_DOMAIN = "leads.brokerstaffer.com";
/** Placeholder local part until the client picks one (open question). */
export const DEFAULT_FROM_ADDRESS = `agents@${RELAY_DOMAIN}`;

export function liveSendAllowed(env: Env = process.env): boolean {
  return env[LIVE_SEND_ENV]?.trim() === "1";
}

/*
 * THE PILOT FENCE (24 Oct — BrokerStaffer's own hand-off goes live first; the
 * user: "make sure no other client receives any email. only brokerstaffer
 * should get emails"). While OS_BROKERAGE_RELAY_LIVE_ONLY is set, a live
 * hand-off may go only to addresses on its domains ("brokerstaffer.com") —
 * every recipient, exact domain, no subdomains. Anything else is practised
 * instead (relay.ts) and the Postmark transport refuses it outright too, so
 * a brokerage switched on by mistake still emails no one. Unset: no fence —
 * going live for clients means removing it, deliberately. Set but naming no
 * valid domain: nothing may go.
 */
export function liveOnlyDomains(env: Env = process.env): string[] | null {
  const raw = env[LIVE_ONLY_ENV];
  if (raw === undefined) return null;
  return raw.split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d));
}

/** True when the fence lets every one of these addresses receive a live hand-off (always, with no fence; never, with no address). */
export function withinLiveFence(addresses: readonly string[], env: Env = process.env): boolean {
  const domains = liveOnlyDomains(env);
  if (domains === null) return true;
  return addresses.length > 0 && addresses.every((a) => {
    const parts = a.trim().toLowerCase().split("@");
    return parts.length === 2 && !!parts[0] && domains.includes(parts[1]);
  });
}

/** OS_BROKERAGE_RELAY=0 stops the sweep outright, whatever the database says. */
export function sweepSwitchedOff(env: Env = process.env): boolean {
  return env[SWEEP_OFF_ENV]?.trim() === "0";
}

export function postmarkToken(env: Env = process.env): string | null {
  const t = env[TOKEN_ENV]?.trim();
  return t ? t : null;
}

/** Postmark's transactional stream — one-to-one mail, no unsubscribe footer, its own reputation. */
export const DEFAULT_STREAM = "outbound";

/*
 * The message stream. A hand-off is one person's email to another, so it
 * goes on a TRANSACTIONAL stream. Postmark's default broadcast stream is
 * named "broadcast"; it is for bulk mail and adds an unsubscribe footer to
 * the agent's words, so it is refused here whatever the environment says.
 */
export function messageStream(env: Env = process.env): string {
  const v = env[STREAM_ENV]?.trim();
  if (!v || !/^[a-z0-9-]{1,30}$/i.test(v) || /^broadcasts?$/i.test(v)) return DEFAULT_STREAM;
  return v;
}

const RELAY_ADDRESS = new RegExp(`^[a-z0-9._%+-]+@${RELAY_DOMAIN.replace(/\./g, "\\.")}$`);

/** True for an address on the relay's own domain — the only kind it may send From. Exactly one @. */
export function isRelayAddress(address: string | null | undefined): boolean {
  return RELAY_ADDRESS.test((address ?? "").trim().toLowerCase());
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
