import { isRelayAddress, LIVE_SEND_ENV, liveSendAllowed, messageStream, postmarkToken, TOKEN_ENV, type Env } from "./gate.ts";
import { addressHeader, type RelayEmail } from "./message.ts";
import { TEST_RECIPIENTS } from "./test-send.ts";

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
      /** Postmark refused some of several addresses as inactive: the others may have received it (unknown, like a timeout). */
      partial?: true;
    };

export interface Transport {
  send(email: RelayEmail): Promise<SendResult>;
}

/** Postmark's /email body. Open and link tracking off: nothing is added to the agent's words. */
export function postmarkPayload(email: RelayEmail, stream: string): Record<string, unknown> {
  return {
    // Built here from the address the locks checked — never a caller's From header (21 Oct review).
    From: addressHeader(email.fromName, email.fromAddress),
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
        /*
         * Only a 4xx is a definite "not accepted" (422 invalid / inactive
         * recipient, 401 bad token, 429 too many). A 5xx, or a 2xx we cannot
         * read, may have been accepted — treated like a dropped connection, so
         * the agent's slot is kept and nothing is retried by itself.
         */
        const detail = `(${res.status}, code ${body?.ErrorCode ?? "?"}): ${String(body?.Message ?? "no answer").slice(0, 300)}`;
        /*
         * 406 is "inactive recipient" (an earlier hard bounce or spam report).
         * With several people on it, Postmark does not say whether the others
         * still got it (21 Oct review) — so not definite: no slot freed, no
         * "Try again", a person checks Postmark's activity first.
         */
        if (body?.ErrorCode === 406 && email.to.length > 1) {
          return { ok: false, gated: null, error: `Postmark refused an inactive address ${detail}`, definite: false, partial: true };
        }
        const definite = res.status >= 400 && res.status < 500;
        return { ok: false, gated: null, error: `${definite ? "Postmark refused" : "Postmark's answer was unclear"} ${detail}`, definite };
      } catch (e) {
        return { ok: false, gated: null, error: `Postmark did not answer: ${e instanceof Error ? e.message : String(e)}`, definite: false };
      }
    },
  };
}

/*
 * A TEST send (test-send.ts) — the one Postmark call that does not need
 * OS_BROKERAGE_RELAY_LIVE_SEND, so testing never means switching the hand-off
 * live. In exchange it refuses, before any request is built, anything that is
 * not exactly one recipient on TEST_RECIPIENTS with Reply-To the same address:
 * it cannot reach a brokerage or an agent, whatever a caller passes it. From
 * is built from the checked address (postmarkPayload), as for a live send.
 */
export async function sendTest(email: RelayEmail, deps: TransportDeps & { allowed?: readonly string[] } = {}): Promise<SendResult> {
  const env = deps.env ?? process.env;
  // The hand-off's test list as relay.ts checked it (test-send.ts), else the fixed address.
  const allowed = (deps.allowed?.length ? deps.allowed : TEST_RECIPIENTS).map((x) => x.trim().toLowerCase());
  const isTestRecipient = (x: string | null | undefined) => allowed.includes(String(x ?? "").trim().toLowerCase());
  const token = postmarkToken(env);
  if (!token) return { ok: false, gated: "no_token", error: `${TOKEN_ENV} is not set — nothing was sent`, definite: true };
  if (!isRelayAddress(email.fromAddress)) {
    return { ok: false, gated: "bad_from", error: "From is not on leads.brokerstaffer.com — nothing was sent", definite: true };
  }
  // Reply-To exactly the bare test address: no name, no list (a "someone@x.com, <admin@…>" read only its last <…> — 21 Oct review).
  if (email.to.length !== 1 || !isTestRecipient(email.to[0].email) || email.toHeader.trim().toLowerCase() !== email.to[0].email.trim().toLowerCase() || !isTestRecipient(email.replyTo)) {
    return { ok: false, gated: "no_recipients", error: "A test goes only to our own test address — nothing was sent", definite: true };
  }
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(`${POSTMARK_API}/email`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": token },
      body: JSON.stringify({ ...postmarkPayload(email, messageStream(env)), Headers: [], Tag: "brokerage-relay-test" }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { ErrorCode?: number; Message?: string; MessageID?: string; SubmittedAt?: string } | null;
    if (res.ok && body?.ErrorCode === 0 && body.MessageID) return { ok: true, messageId: body.MessageID, submittedAt: body.SubmittedAt ?? null };
    return { ok: false, gated: null, error: `Postmark (${res.status}, code ${body?.ErrorCode ?? "?"}): ${String(body?.Message ?? "no answer").slice(0, 300)}`, definite: res.status >= 400 && res.status < 500 };
  } catch (e) {
    return { ok: false, gated: null, error: `Postmark did not answer: ${e instanceof Error ? e.message : String(e)}`, definite: false };
  }
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
 * Which of Postmark's bounce records mean the hand-off did NOT reach someone
 * (or reached them and was reported as spam). Postmark lists more than
 * failures under /bounces: an out-of-office from Angela ("AutoResponder"), a
 * delay it is still retrying ("Transient"), a forwarding notice
 * ("AddressChange") — the email arrived, so those are not bounces here.
 */
const NOT_A_FAILURE = new Set(["Transient", "AutoResponder", "AddressChange", "Subscribe", "ChallengeVerification", "OpenRelayTest"]);
const SPAM_REPORT = new Set(["SpamComplaint", "SpamNotification"]);

export function bounceKind(type: string | null | undefined): "ignore" | "spam" | "bounce" {
  const t = String(type ?? "").trim();
  if (NOT_A_FAILURE.has(t)) return "ignore";
  return SPAM_REPORT.has(t) ? "spam" : "bounce";
}

/** Postmark's page size limit for GET /bounces. */
const BOUNCE_PAGE = 500;
const MAX_BOUNCE_PAGES = 10;

/*
 * Bounces since a date — a READ (GET /bounces), used for the plan's "an alert
 * if any email bounces" without opening a public webhook in the proxy. Only
 * called when something was actually sent. Every page is read (a capped first
 * page is never taken for the whole list); more than 5,000 in the window is
 * an error rather than a silent cut.
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
  const all: PostmarkBounce[] = [];
  try {
    for (let page = 0; page < MAX_BOUNCE_PAGES; page++) {
      const res = await doFetch(`${POSTMARK_API}/bounces?count=${BOUNCE_PAGE}&offset=${page * BOUNCE_PAGE}&fromdate=${fromdate}`, {
        method: "GET",
        headers: { Accept: "application/json", "X-Postmark-Server-Token": token },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, error: `Postmark answered ${res.status}` };
      const body = (await res.json().catch(() => null)) as { Bounces?: PostmarkBounce[]; TotalCount?: number } | null;
      const rows = Array.isArray(body?.Bounces) ? body!.Bounces : [];
      all.push(...rows);
      const total = typeof body?.TotalCount === "number" ? body.TotalCount : null;
      if (rows.length < BOUNCE_PAGE || (total !== null && all.length >= total)) return { ok: true, bounces: all };
    }
    return { ok: false, error: `more than ${MAX_BOUNCE_PAGES * BOUNCE_PAGE} bounces since ${fromdate} — not read in full` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
