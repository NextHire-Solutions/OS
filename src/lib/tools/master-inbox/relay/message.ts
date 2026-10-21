import { plainTextToHtml } from "../inbox/plain-text-html.ts";

import { ownText, type LeadFacts, type MessageFacts, type Recipient } from "./rules.ts";

/*
 * The email the brokerage receives — exactly as the approved plan draws it
 * (plan §2, "What the brokerage sees"):
 *
 *   From      Jordan Ellis via BrokerStaffer <agents@leads.brokerstaffer.com>
 *   To        the brokerage's people for this agent's market
 *   Reply-To  the agent's own address — Reply goes straight to them
 *   Subject   Re: <the conversation's subject>
 *   Body      the agent's reply, then the earlier messages of THIS
 *             conversation quoted underneath. "We add nothing on top."
 *
 * With the agent's Message-ID in In-Reply-To / References, the brokerage's
 * answer lands in the agent's same conversation, under the same subject.
 *
 * 21 Oct: the "notification" version of 20 Oct (its own subject, a line from
 * BrokerStaffer on top, nothing quoted) was never agreed with the client and
 * is undone. Eddy: "The whole point was to continue the conversation in the
 * same thread. With same subject."
 *
 * Pure. Built from the conversation's own messages only — never another
 * conversation with the same agent (plan §4: "Each brokerage only ever
 * receives its own conversation").
 */

export const VIA = "via BrokerStaffer";
/** Earlier messages quoted under the reply, newest first. */
export const MAX_QUOTED = 10;
const MAX_QUOTED_CHARS = 5000;

export interface RelayEmail {
  fromName: string;
  fromAddress: string;
  /** The From header as sent. */
  from: string;
  to: Recipient[];
  /** The To header as sent. */
  toHeader: string;
  replyTo: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  headers: Array<{ Name: string; Value: string }>;
  metadata: Record<string, string>;
}

/**
 * A display name that cannot break out of its quotes or pass for an address:
 * control characters (CR/LF included), quotes, backslashes and angle brackets
 * are removed, and anything that looks like an address keeps only its name.
 * Invisible characters too (21 Oct review): right-to-left overrides and
 * zero-width ones in a sender's own display name can make the From read as
 * something else.
 */
export function cleanDisplayName(raw: string | null | undefined): string {
  let s = String(raw ?? "")
    .replace(/[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  if (s.includes("<")) s = s.slice(0, s.indexOf("<"));
  if (s.includes("@")) s = s.slice(0, s.indexOf("@"));
  return s.replace(/["\\<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** What the brokerage reads when the agent's name is not known. */
export const NO_NAME = "An agent";

/*
 * A name guessed from the address only when it reads as one (21 Oct review):
 * "jordan.ellis@" → "Jordan Ellis", but never "Info" or "Jsmith1985" — a
 * mailbox, or a run-together name, is "An agent".
 */
const MAILBOX_WORDS = new Set(["info", "admin", "contact", "office", "sales", "hello", "hi", "team", "mail", "email", "support", "help", "homes", "realty", "realtor", "realestate", "properties", "listings", "inquiries", "enquiries", "noreply", "reply", "agent", "broker", "home", "me"]);
function nameFromAddress(email: string | null | undefined): string {
  const local = String(email ?? "").split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return "";
  if (!parts.every((p) => /^[a-z]{2,}$/i.test(p) && !MAILBOX_WORDS.has(p.toLowerCase()))) return "";
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}

/** The agent's name as the brokerage should read it. */
export function agentDisplayName(lead: LeadFacts, reply: Pick<MessageFacts, "senderName" | "sender"> | null): string {
  return (
    cleanDisplayName(lead.fullName) ||
    cleanDisplayName(reply?.senderName) ||
    cleanDisplayName(nameFromAddress(lead.email ?? reply?.sender)) ||
    NO_NAME
  );
}

/** `"Name" <address>`, or the bare address when there is no name. */
export function addressHeader(name: string | null | undefined, email: string): string {
  const n = cleanDisplayName(name);
  return n && n !== NO_NAME ? `"${n}" <${email}>` : email;
}

const MAX_SUBJECT = 200;

/**
 * "Re: <subject>", with exactly one Re: however many the conversation piled
 * up. Control characters (CR/LF included) become spaces, and a runaway
 * subject is cut at a word: one line, nothing a header could be split on.
 */
export function relaySubject(threadSubject: string | null | undefined, replySubject: string | null | undefined): string {
  let base = String((threadSubject ?? "").trim() || (replySubject ?? "").trim())
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 10; i++) {
    const next = base.replace(/^(re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === base) break;
    base = next.trim();
  }
  if (base.length > MAX_SUBJECT) base = `${base.slice(0, MAX_SUBJECT).replace(/\s+\S*$/, "")}…`;
  return `Re: ${base || "(no subject)"}`;
}

const QUOTE_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/* "nicole.c@…" → "Nicole": the name part of an address, letters only. */
function nameFromLocalPart(email: string | null | undefined): string {
  const local = String(email ?? "").split("@")[0] ?? "";
  return local
    .split(/[._+-]+/)
    .filter((p) => /^[a-z]{2,}$/i.test(p) && !MAILBOX_WORDS.has(p.toLowerCase()))
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

/*
 * Who wrote a quoted message. Ours by name — never the sending inbox's address
 * (21 Oct: no outbound message carries a stored name, and our campaign domains
 * must stay out of the brokerage's copy): "nicole@…" reads "Nicole", as the
 * plan's example reads "Nicole Collins wrote:". The agent's, by name or address.
 */
function quoteName(m: Pick<MessageFacts, "senderName" | "sender" | "direction">): string {
  const named = cleanDisplayName(m.senderName);
  if (m.direction === "outbound") {
    // A stored From name that is a domain or an address ("recruit-mail-xyz.com") would name our sending domain (22 Oct audit).
    const person = named && !/@|\.[a-z]{2,}\b/i.test(named) ? named : "";
    return person || nameFromLocalPart(m.sender) || "BrokerStaffer";
  }
  if (named) return named;
  return (m.sender ?? "").trim() || "The agent";
}

/** "On Mon, Oct 5, 2026, 10:42 AM, Nicole Collins wrote:" — how mail clients introduce a quote. */
export function quoteHeader(m: Pick<MessageFacts, "sentAt" | "senderName" | "sender" | "direction">): string {
  const who = quoteName(m);
  const t = m.sentAt ? Date.parse(m.sentAt) : NaN;
  return Number.isFinite(t) ? `On ${QUOTE_DATE.format(new Date(t))}, ${who} wrote:` : `${who} wrote:`;
}

/*
 * A quoted message's text. Our own emails are read from their HTML: the
 * providers' plain-text copy runs the paragraphs together ("Hey James,Given
 * your experience…", 21 Oct), the HTML keeps them.
 */
function quoteText(m: MessageFacts): string {
  const fromHtml = m.direction === "outbound" && m.bodyHtml ? ownText({ bodyText: null, bodyHtml: m.bodyHtml }) : "";
  // Never the raw body (22 Oct audit): a message that is all quote would bring its own "On … <sender@our-domain> wrote:" with it. Nothing left → not quoted.
  return clip(fromHtml || ownText(m));
}

/** The earlier messages to quote: this conversation's, before the reply, newest first. */
export function quotedHistory(messages: MessageFacts[], reply: MessageFacts): MessageFacts[] {
  const at = reply.sentAt ? Date.parse(reply.sentAt) : NaN;
  return messages
    .filter((m) => m.id !== reply.id)
    .filter((m) => {
      const t = m.sentAt ? Date.parse(m.sentAt) : NaN;
      return Number.isFinite(at) && Number.isFinite(t) && t < at;
    })
    .sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)))
    .slice(0, MAX_QUOTED);
}

function clip(text: string): string {
  return text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS).trimEnd()}…` : text;
}

/*
 * The agent's own words — and nothing else (21 Oct review). It used to fall
 * back to the whole message when stripping quotes left nothing, so a reply
 * that was only a quote (an attachment, a bottom-post) sent the brokerage our
 * cold outreach and our sender's address. Now that is "" — skipped as
 * empty_reply, for the team to handle by hand.
 */
export function replyText(reply: MessageFacts): string {
  return ownText(reply);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/*
 * The agent's reply inside what the provider stored for it (messages.raw_payload).
 * Only the shapes the sync code writes are read (sync/emailbison.ts,
 * sync/instantly.ts):
 *
 *   EmailBison webhook       { event, data: { reply, lead, campaign, scheduled_email, … } }
 *   EmailBison, wrapped      { data: { event, data: { reply, … } } }   (the test-event sample)
 *   EmailBison conversation  the reply object itself: { id, raw_message_id, automated_reply, … }
 *   Instantly email          the email object itself: { id, message_id, ue_type, … }
 *
 * Never searched at large: the webhook also carries the SCHEDULED email (our
 * own outreach) and the lead, and a Message-ID found there is not the agent's.
 */
export function replyFromPayload(payload: unknown): Obj | null {
  if (!isObj(payload)) return null;
  const data = isObj(payload.data) ? payload.data : null;
  if (data && isObj(data.reply)) return data.reply;
  if (data && isObj(data.data) && isObj((data.data as Obj).reply)) return (data.data as Obj).reply as Obj;
  if ("raw_message_id" in payload || "automated_reply" in payload || "from_email_address" in payload) return payload;
  if ("message_id" in payload && ("ue_type" in payload || "from_address_email" in payload || "eaccount" in payload)) return payload;
  return null;
}

/*
 * The Message-ID of the agent's email, when the provider gave us one, so the
 * brokerage's answer threads into the agent's own conversation (In-Reply-To /
 * References). Anything not shaped like a Message-ID is ignored, and nothing
 * is ever made up: without one the headers are simply left out.
 */
export function messageIdFromPayload(payload: unknown): string | null {
  const reply = replyFromPayload(payload);
  if (!reply) return null;
  for (const key of ["raw_message_id", "message_id"]) {
    const v = reply[key];
    if (typeof v !== "string") continue;
    const id = v.trim().replace(/^<|>$/g, "");
    if (/^[^\s<>@]+@[^\s<>@]+$/.test(id)) return `<${id}>`;
  }
  return null;
}

/** EmailBison's own verdict that the reply is automatic (an out-of-office, an auto-responder). */
export function providerSaysAutomatic(payload: unknown): boolean {
  return replyFromPayload(payload)?.automated_reply === true;
}

export interface BuildInput {
  relayId: string;
  threadId: string;
  fromAddress: string;
  agentName: string;
  replyTo: string;
  recipients: Recipient[];
  threadSubject: string | null;
  reply: MessageFacts;
  /** Every message of THIS conversation; the earlier ones are quoted. */
  messages: MessageFacts[];
  agentMessageId: string | null;
}

export function buildRelayEmail(input: BuildInput): RelayEmail {
  // The name is cut to leave room for " via BrokerStaffer": the From name is 80 characters at most (postmark.ts cleans it again).
  const fromName = `${(cleanDisplayName(input.agentName) || NO_NAME).slice(0, 80 - VIA.length - 1).trim()} ${VIA}`;
  const own = replyText(input.reply);
  // The agent's words first — nothing on top — then this conversation's earlier messages, quoted as a mail client quotes them.
  const quoted = quotedHistory(input.messages, input.reply).map((m) => ({ header: quoteHeader(m), text: quoteText(m) })).filter((q) => q.text);

  const textParts = [own];
  for (const q of quoted) {
    textParts.push(`${q.header}\n${q.text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}`);
  }
  const textBody = textParts.join("\n\n");

  const blockquote = 'style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex"';
  const htmlQuoted = quoted
    .map((q) => `<div>${plainTextToHtml(q.header)}<blockquote ${blockquote}>${plainTextToHtml(q.text)}</blockquote></div>`)
    .join("");
  const htmlBody = `<div>${plainTextToHtml(own)}</div>${htmlQuoted ? `<br><div class="gmail_quote">${htmlQuoted}</div>` : ""}`;

  const headers: RelayEmail["headers"] = [];
  if (input.agentMessageId) {
    headers.push({ Name: "In-Reply-To", Value: input.agentMessageId });
    headers.push({ Name: "References", Value: input.agentMessageId });
  }

  return {
    fromName,
    fromAddress: input.fromAddress,
    from: `"${fromName}" <${input.fromAddress}>`,
    to: input.recipients,
    toHeader: input.recipients.map((r) => addressHeader(r.name, r.email)).join(", "),
    replyTo: addressHeader(input.agentName, input.replyTo),
    subject: relaySubject(input.threadSubject, input.reply.subject),
    textBody,
    htmlBody,
    headers,
    metadata: { relay_id: input.relayId, thread_id: input.threadId },
  };
}
