import { plainTextToHtml } from "../inbox/plain-text-html.ts";

import { ownText, type LeadFacts, type MessageFacts, type Recipient } from "./rules.ts";

/*
 * The email the brokerage receives (plan §2, "What the brokerage sees"):
 *
 *   From      Jordan Ellis via BrokerStaffer <agents@leads.brokerstaffer.com>
 *   To        the brokerage's people for this agent's market
 *   Reply-To  the agent's own address — Reply goes straight to them
 *   Subject   Re: <the conversation's subject>
 *   Body      the agent's reply, then the earlier messages of THIS
 *             conversation quoted underneath. "We add nothing on top."
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
 */
export function cleanDisplayName(raw: string | null | undefined): string {
  let s = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
  if (s.includes("<")) s = s.slice(0, s.indexOf("<"));
  if (s.includes("@")) s = s.slice(0, s.indexOf("@"));
  return s.replace(/["\\<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function nameFromAddress(email: string | null | undefined): string {
  const local = String(email ?? "").split("@")[0] ?? "";
  return local
    .split(/[._-]+/)
    .filter((p) => p && !/^\d+$/.test(p))
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

/** The agent's name as the brokerage should read it. */
export function agentDisplayName(lead: LeadFacts, reply: Pick<MessageFacts, "senderName" | "sender"> | null): string {
  return (
    cleanDisplayName(lead.fullName) ||
    cleanDisplayName(reply?.senderName) ||
    cleanDisplayName(nameFromAddress(lead.email ?? reply?.sender)) ||
    "An agent"
  );
}

/** `"Name" <address>`, or the bare address when there is no name. */
export function addressHeader(name: string | null | undefined, email: string): string {
  const n = cleanDisplayName(name);
  return n ? `"${n}" <${email}>` : email;
}

/** "Re: <subject>", with exactly one Re: however many the conversation piled up. */
export function relaySubject(threadSubject: string | null | undefined, replySubject: string | null | undefined): string {
  let base = String((threadSubject ?? "").trim() || (replySubject ?? "").trim())
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 10; i++) {
    const next = base.replace(/^(re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === base) break;
    base = next.trim();
  }
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

/** "On Mon, Oct 5, 2026, 10:42 AM, Nicole Collins wrote:" — how mail clients introduce a quote. */
export function quoteHeader(m: Pick<MessageFacts, "sentAt" | "senderName" | "sender">): string {
  const who = cleanDisplayName(m.senderName) || (m.sender ?? "").trim() || "BrokerStaffer";
  const t = m.sentAt ? Date.parse(m.sentAt) : NaN;
  return Number.isFinite(t) ? `On ${QUOTE_DATE.format(new Date(t))}, ${who} wrote:` : `${who} wrote:`;
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

/** The agent's own words; when stripping quotes leaves nothing, the message as written. */
export function replyText(reply: MessageFacts): string {
  const own = ownText(reply);
  if (own) return own;
  return String(reply.bodyText ?? "").replace(/\r\n/g, "\n").trim();
}

/*
 * The Message-ID of the agent's email, when the provider gave us one, so the
 * brokerage's answer threads into the agent's own conversation. Providers put
 * it in different places; anything not shaped like a Message-ID is ignored.
 */
export function messageIdFromPayload(payload: unknown, depth = 0): string | null {
  if (!payload || typeof payload !== "object" || depth > 4) return null;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof v === "string" && /^(raw_|rfc(822)?_|internet_)?message[-_]?id(_header)?$/i.test(k)) {
      const id = v.trim().replace(/^<|>$/g, "");
      if (/^[^\s<>@]+@[^\s<>@]+$/.test(id)) return `<${id}>`;
    }
  }
  for (const v of Object.values(payload as Record<string, unknown>)) {
    if (v && typeof v === "object") {
      const found = messageIdFromPayload(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
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
  const fromName = `${cleanDisplayName(input.agentName) || "An agent"} ${VIA}`;
  const own = replyText(input.reply);
  const quoted = quotedHistory(input.messages, input.reply).map((m) => ({
    header: quoteHeader(m),
    text: clip(ownText(m) || String(m.bodyText ?? "").trim()),
  }));

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
