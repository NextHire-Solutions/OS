/*
 * Our team's reply from the portal's chat, by email too (4 Nov, Eddy: "Our reply should reach the client's email as
 * well. They will write to us and log off"). Through Postmark's transactional stream, as the sign-in email is.
 *
 * OFF for clients until the user says so: unless OS_PORTAL_CHAT_EMAIL is exactly "1", this sends only to our own test
 * address (relay/test-send.ts TEST_RECIPIENTS), whatever a caller passes. A deploy alone never emails a client. The reply
 * is in the chat either way, and our team is shown whether the email went.
 *
 * Where the client's answer to that email goes is OS_PORTAL_CHAT_REPLY_TO, a team inbox the user names (9 Nov: "replies
 * should not go to nicole.c@brokerstaffer.com … they are not using this mail address anymore"). Until it is set to an
 * address that can receive mail, nothing is sent at all, test address included.
 */

import { messageStream, postmarkToken, type Env } from "@/lib/tools/master-inbox/relay/gate";
import { isTestRecipient } from "@/lib/tools/master-inbox/relay/test-send";

export const CHAT_EMAIL_ENV = "OS_PORTAL_CHAT_EMAIL";
export const CHAT_EMAIL_FROM = "support@leads.brokerstaffer.com";
export const CHAT_REPLY_TO_ENV = "OS_PORTAL_CHAT_REPLY_TO";
/** A team inbox is one plain address: no quotes, lists, display names or trailing dot. */
const INBOX = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
/**
 * Never where a client's answer goes: an inbox nobody reads any more (9 Nov) — in any spelling that still reaches it
 * (+tags, dots) — and our sending domain, which receives nothing.
 */
const retired = (a: string) => {
  const [local, domain] = a.split("@");
  return (domain === "brokerstaffer.com" && local.replace(/\+.*$/, "").replace(/\./g, "") === "nicolec") || /(^|\.)leads\.brokerstaffer\.com$/.test(domain);
};

const OS_URL = (process.env.OS_PUBLIC_URL ?? "https://os.brokerstaffer.com").replace(/\/+$/, "");
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ChatReplyEmail {
  to: string;
  /** Their first name, if we have one. */
  firstName: string | null;
  /** Who replied, as the chat shows them. */
  from: string | null;
  reply: string;
  /** What they last wrote, so the email makes sense on its own. */
  question: string | null;
}

/** The team inbox a client's answer to the email goes to, or null when none usable is set. */
export function chatReplyTo(env: Env = process.env): string | null {
  const a = (env[CHAT_REPLY_TO_ENV] ?? "").trim().toLowerCase();
  return INBOX.test(a) && !retired(a) ? a : null;
}

/** Are replies emailed to clients, as our team is told under the reply box? The switch, and a team inbox for the answer. */
export function chatEmailOn(env: Env = process.env): boolean {
  return env[CHAT_EMAIL_ENV]?.trim() === "1" && chatReplyTo(env) !== null;
}

/** May this address be sent a chat reply at all, right now? Never without a team inbox for the answer. */
export function mayEmailReply(address: string, env: Env = process.env): boolean {
  const a = address.trim().toLowerCase();
  return ADDRESS.test(a) && (chatEmailOn(env) || (chatReplyTo(env) !== null && isTestRecipient(a)));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const lines = (s: string) => esc(s).replace(/\r?\n/g, "<br>");

/** A reply typed in the chat often greets them already ("Hi Jane!"): the email doesn't greet them twice. */
const GREETS = /^\s*(hi|hello|hey|dear|good (morning|afternoon|evening))\b/i;

export function chatReplyMessage(mail: ChatReplyEmail): { subject: string; text: string; html: string } {
  const hi = GREETS.test(mail.reply) ? null : mail.firstName ? `Hi ${mail.firstName},` : "Hi,";
  const signIn = `${OS_URL}/portal-signin`;
  const who = mail.from ? `${mail.from}, BrokerStaffer` : "BrokerStaffer";
  const subject = "We replied to your question";
  const text = [
    ...(hi ? [hi, ""] : []),
    ...(mail.question ? [`You asked: "${mail.question}"`, ""] : []),
    mail.reply,
    "",
    who,
    "",
    `Reply to this email to answer us, or see the conversation in your portal's chat: ${signIn}`,
  ].join("\n");
  const html =
    `<div style="font:15px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2124;max-width:520px">` +
    (hi ? `<p>${esc(hi)}</p>` : "") +
    (mail.question ? `<p style="color:#6b7280;border-left:3px solid #e3e6eb;padding-left:12px">You asked: ${lines(mail.question)}</p>` : "") +
    `<p>${lines(mail.reply)}</p>` +
    `<p>${esc(who)}</p>` +
    `<p style="color:#6b7280;font-size:13px">Reply to this email to answer us, or see the conversation in <a href="${esc(signIn)}" style="color:#3e6bd1">your portal's chat</a>.</p></div>`;
  return { subject, text, html };
}

/** Sends one reply. Refuses (throws) anything the gate doesn't allow. */
export async function sendChatReplyEmail(mail: ChatReplyEmail, deps: { fetch?: typeof fetch; env?: Env } = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const replyTo = chatReplyTo(env);
  if (!replyTo) throw new Error(`No team inbox for answers: ${CHAT_REPLY_TO_ENV} isn't set to an address that can receive them.`);
  if (!mayEmailReply(mail.to, env)) throw new Error("Chat reply emails are switched off for that address.");
  const token = postmarkToken(env);
  if (!token) throw new Error("POSTMARK_SERVER_TOKEN is not set.");
  const m = chatReplyMessage(mail);
  const res = await (deps.fetch ?? fetch)("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": token },
    body: JSON.stringify({
      From: `"BrokerStaffer" <${CHAT_EMAIL_FROM}>`,
      ReplyTo: replyTo,
      To: mail.to.trim().toLowerCase(),
      Subject: m.subject,
      TextBody: m.text,
      HtmlBody: m.html,
      MessageStream: messageStream(env),
      TrackOpens: false,
      TrackLinks: "None",
      Tag: "portal-chat-reply",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as { ErrorCode?: number; Message?: string } | null;
  if (!res.ok || body?.ErrorCode !== 0) throw new Error(`Postmark ${res.status} (code ${body?.ErrorCode ?? "?"})`);
}
