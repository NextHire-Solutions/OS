import { isRelayAddress, LIVE_SEND_ENV, liveSendAllowed, messageStream, postmarkToken, TOKEN_ENV, type Env } from "./gate.ts";
import type { RelayEmail } from "./message.ts";

/*
 * Postmark — the only code that can put a hand-off in a brokerage's inbox.
 *
 * ---------------------------------------------------------------------------
 * IT REFUSES BEFORE IT BUILDS A REQUEST
 *
 * `send` checks, in order, and returns `gated` without touching the network
 * when any is missing:
 *
 *   1. OS_BROKERAGE_RELAY_LIVE_SEND is exactly "1"     (default: unset)
 *   2. POSTMARK_SERVER_TOKEN is set                    (default: unset)
 *   3. From is on leads.brokerstaffer.com
 *   4. there is somebody to send to
 *
 * The relay has already decided "live" before it calls this (relay.ts, which
 * also needs the Settings switches); this is the second, independent lock, so
 * a caller that forgot the first still cannot send. Tests inject `fetch` and
 * assert it is never called while the switch is off.
 *
 * The token is sent only in Postmark's header and never appears in a result,
 * a log line or an error.
 */

export const POSTMARK_API = "https://api.postmarkapp.com";

export type SendResult =
  | { ok: true; messageId: string; submittedAt: string | null }
  | {
      ok: false;
      /** Set when a lock refused it — nothing was attempted. */
      gated: "live_send_off" | "no_token" | "bad_from" | "no_recipients" | null;
      error: string;
      /**
       * True when Postmark definitely did not accept it (a refusal, or gated).
       * False when the outcome is unknown (timeout, connection dropped) — it
       * may have been sent, so it must not be retried automatically.
       */
      definite: boolean;
    };

export interface Transport {
  send(email: RelayEmail): Promise<SendResult>;
}

/** Postmark's /email body. Open and link tracking off: nothing is added to the agent's words. */
export function postmarkPayload(email: RelayEmail, stream: string): Record<string, unknown> {
  return {
    From: email.from,
    To: email.toHeader,
    ReplyTo: email.replyTo,
    Subject: email.subject,
    TextBody: email.textBody,
    HtmlBody: email.htmlBody,
    MessageStream: stream,
    TrackOpens: false,
    TrackLinks: "None",
    Tag: "brokerage-relay",
    Headers: email.headers,
    Metadata: email.metadata,
  };
}

export interface TransportDeps {
  fetch?: typeof fetch;
  env?: Env;
}

export function createPostmarkTransport(deps: TransportDeps = {}): Transport {
  return {
    async send(email) {
      const env = deps.env ?? process.env;
      if (!liveSendAllowed(env)) {
        return { ok: false, gated: "live_send_off", error: `${LIVE_SEND_ENV} is not set to 1 — nothing was sent`, definite: true };
      }
      const token = postmarkToken(env);
      if (!token) return { ok: false, gated: "no_token", error: `${TOKEN_ENV} is not set — nothing was sent`, definite: true };
      if (!isRelayAddress(email.fromAddress)) {
        return { ok: false, gated: "bad_from", error: "From is not on leads.brokerstaffer.com — nothing was sent", definite: true };
      }
      if (!email.to.length) return { ok: false, gated: "no_recipients", error: "No recipient — nothing was sent", definite: true };

      const doFetch = deps.fetch ?? fetch;
      try {
        const res = await doFetch(`${POSTMARK_API}/email`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": token },
          body: JSON.stringify(postmarkPayload(email, messageStream(env))),
          signal: AbortSignal.timeout(15_000),
        });
        const body = (await res.json().catch(() => null)) as { ErrorCode?: number; Message?: string; MessageID?: string; SubmittedAt?: string } | null;
        if (res.ok && body?.ErrorCode === 0 && body.MessageID) {
          return { ok: true, messageId: body.MessageID, submittedAt: body.SubmittedAt ?? null };
        }
        return {
          ok: false,
          gated: null,
          error: `Postmark refused (${res.status}, code ${body?.ErrorCode ?? "?"}): ${String(body?.Message ?? "no answer").slice(0, 300)}`,
          definite: true,
        };
      } catch (e) {
        return { ok: false, gated: null, error: `Postmark did not answer: ${e instanceof Error ? e.message : String(e)}`, definite: false };
      }
    },
  };
}

/** One bounce as Postmark's GET /bounces lists it (the fields used here). */
export interface PostmarkBounce {
  ID: number;
  Type: string;
  MessageID: string;
  Email: string;
  Description?: string;
  BouncedAt?: string;
}

/*
 * Bounces since a date — a READ (GET /bounces), used for the plan's "an alert
 * if any email bounces" without opening a public webhook in the proxy. Only
 * called when something was actually sent.
 */
export async function fetchBounces(
  since: Date,
  deps: TransportDeps = {},
): Promise<{ ok: true; bounces: PostmarkBounce[] } | { ok: false; error: string }> {
  const env = deps.env ?? process.env;
  const token = postmarkToken(env);
  if (!token) return { ok: false, error: `${TOKEN_ENV} is not set` };
  const doFetch = deps.fetch ?? fetch;
  const fromdate = since.toISOString().slice(0, 10);
  try {
    const res = await doFetch(`${POSTMARK_API}/bounces?count=100&offset=0&fromdate=${fromdate}`, {
      method: "GET",
      headers: { Accept: "application/json", "X-Postmark-Server-Token": token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `Postmark answered ${res.status}` };
    const body = (await res.json().catch(() => null)) as { Bounces?: PostmarkBounce[] } | null;
    return { ok: true, bounces: Array.isArray(body?.Bounces) ? body!.Bounces : [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
