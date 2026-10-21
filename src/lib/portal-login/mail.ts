/*
 * The sign-in email (21 Oct): a link and a 6-digit code, from BrokerStaffer on
 * leads.brokerstaffer.com, through Postmark's transactional stream.
 *
 * Sign-in is OFF for clients until the new portal launches: unless
 * OS_CLIENT_SIGNIN is exactly "1", this sends only to our own test address
 * (relay/test-send.ts TEST_RECIPIENTS — admin@outreachify.io), whatever a
 * caller passes. So it can be tried end to end in our own Gmail, and no client
 * receives anything before the user says launch.
 */

import { messageStream, postmarkToken, type Env } from "@/lib/tools/master-inbox/relay/gate";
import { isTestRecipient } from "@/lib/tools/master-inbox/relay/test-send";

import { isEmail, normEmail, type SignInEmail } from "./login";

export const SIGNIN_ENV = "OS_CLIENT_SIGNIN";
export const SIGNIN_FROM = "login@leads.brokerstaffer.com";

/** Open for every address on a portal's list only when the switch is exactly "1". */
export function signInOpen(env: Env = process.env): boolean {
  return env[SIGNIN_ENV]?.trim() === "1";
}

/** May this address be sent a sign-in email at all, right now? */
export function mayEmail(address: string, env: Env = process.env): boolean {
  const a = normEmail(address);
  return isEmail(a) && (signInOpen(env) || isTestRecipient(a));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function signInMessage(mail: SignInEmail): { subject: string; text: string; html: string } {
  const code = `${mail.code.slice(0, 3)} ${mail.code.slice(3)}`;
  const subject = "Your BrokerStaffer sign-in link";
  const text = [
    "Hi,",
    "",
    `Use this link to sign in to your BrokerStaffer portal. It works once, for the next ${mail.minutes} minutes:`,
    mail.link,
    "",
    `Or enter this code on the sign-in page: ${code}`,
    "",
    "If you didn't ask to sign in, you can ignore this email — nobody can sign in without it.",
    "",
    "BrokerStaffer",
  ].join("\n");
  const html =
    `<div style="font:15px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2124;max-width:480px">` +
    `<p>Hi,</p>` +
    `<p>Use this button to sign in to your BrokerStaffer portal. It works once, for the next ${mail.minutes}&nbsp;minutes.</p>` +
    `<p style="margin:24px 0"><a href="${esc(mail.link)}" style="background:#3e6bd1;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Sign in to BrokerStaffer</a></p>` +
    `<p>Or enter this code on the sign-in page: <b style="font-size:18px;letter-spacing:2px">${esc(code)}</b></p>` +
    `<p style="color:#6b7280;font-size:13px">If you didn't ask to sign in, you can ignore this email — nobody can sign in without it.</p>` +
    `<p>BrokerStaffer</p></div>`;
  return { subject, text, html };
}

/** Sends one sign-in email. Refuses (throws) anything the gate does not allow; never logs the link or the code. */
export async function sendSignInEmail(mail: SignInEmail, deps: { fetch?: typeof fetch; env?: Env } = {}): Promise<void> {
  const env = deps.env ?? process.env;
  if (!mayEmail(mail.to, env)) throw new Error("Sign-in emails are not open for that address.");
  const token = postmarkToken(env);
  if (!token) throw new Error("POSTMARK_SERVER_TOKEN is not set.");
  const m = signInMessage(mail);
  const res = await (deps.fetch ?? fetch)("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": token },
    body: JSON.stringify({
      From: `"BrokerStaffer" <${SIGNIN_FROM}>`,
      To: normEmail(mail.to),
      Subject: m.subject,
      TextBody: m.text,
      HtmlBody: m.html,
      MessageStream: messageStream(env),
      TrackOpens: false,
      TrackLinks: "None",
      Tag: "portal-signin",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as { ErrorCode?: number; Message?: string } | null;
  if (!res.ok || body?.ErrorCode !== 0) throw new Error(`Postmark ${res.status} (code ${body?.ErrorCode ?? "?"})`);
}
