import { plainTextToHtml } from "../inbox/plain-text-html.ts";

import { ownText, type LeadFacts, type MessageFacts, type Recipient } from "./rules.ts";

/*
 * The email the brokerage receives — a notification (20 Oct, the user chose
 * "notification style" after the first test landed in spam):
 *
 *   From      Jordan Ellis via BrokerStaffer <agents@leads.brokerstaffer.com>
 *   To        the brokerage's people for this agent's market
 *   Reply-To  the agent's own address — Reply goes straight to them
 *   Subject   Jordan Ellis is interested — reply to reach them
 *   Body      one line from BrokerStaffer, then the agent's own words only.
 *             Our outreach is never quoted under them.
 *
 * Pure. Built from the conversation's own messages only — never another
 * conversation with the same agent (plan §4: "Each brokerage only ever
 * receives its own conversation").
 */

export const VIA = "via BrokerStaffer";

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

const TITLE = /^(dr|mr|mrs|ms|miss|mx|prof|sir|rev)\.?$/i;

/*
 * The first name for "reach <first> directly" (21 Oct review): past a title
 * ("Dr. Jane Smith" → Jane), from "Smith, John" (→ John), and "them" when
 * there is no telling (an initial, a digit, the unknown agent).
 */
export function firstNameOf(name: string | null | undefined): string {
  const n = cleanDisplayName(name);
  if (!n || n === NO_NAME) return "them";
  const comma = n.split(",").map((p) => p.trim()).filter(Boolean);
  // "Smith, John" — one word before the comma; "John Smith, Realtor" keeps John.
  const given = comma.length === 2 && !/\s/.test(comma[0]) ? comma[1] : comma[0] ?? n;
  const words = given.split(/\s+/).filter((w) => !TITLE.test(w));
  const first = words[0] ?? "";
  return /^\p{L}[\p{L}'’-]+$/u.test(first) ? first : "them";
}

/** `"Name" <address>`, or the bare address when there is no name. */
export function addressHeader(name: string | null | undefined, email: string): string {
  const n = cleanDisplayName(name);
  return n && n !== NO_NAME ? `"${n}" <${email}>` : email;
}

const MAX_SUBJECT = 200;

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
  /** Every message of THIS conversation (none is quoted any more — the agent's reply is picked from them by the caller). */
  messages: MessageFacts[];
  agentMessageId: string | null;
}

/*
 * The subject, as a notification (20 Oct): "<Agent> is interested — reply to
 * reach them". Not a "Re:" — the brokerage has no earlier conversation, and a
 * "Re:" from a sender they have never written to is a well-known spam sign
 * (the first test landed in Gmail's spam: "similar to messages identified as
 * spam"). One line, control characters removed, cut at a word.
 */
export function handoffSubject(agentName: string | null | undefined): string {
  const name = cleanDisplayName(agentName) || NO_NAME;
  const s = `${name} is interested — reply to reach them`;
  return s.length > MAX_SUBJECT ? `${s.slice(0, MAX_SUBJECT).replace(/\s+\S*$/, "")}…` : s;
}

/** BrokerStaffer's one line at the top, so the brokerage (and its mail filter) know what this is. */
export function handoffIntro(agentName: string | null | undefined): string {
  const name = cleanDisplayName(agentName) || NO_NAME;
  const first = firstNameOf(name);
  return `${name} replied to your BrokerStaffer recruiting campaign and is interested.\nReply to this email to reach ${first} directly.`;
}

export function buildRelayEmail(input: BuildInput): RelayEmail {
  const fromName = `${cleanDisplayName(input.agentName) || NO_NAME} ${VIA}`;
  const own = replyText(input.reply);
  /*
   * The agent's own words under one line from BrokerStaffer — and NOT our cold
   * outreach quoted below them (20 Oct, the user chose "notification style"):
   * that quote is the part spam filters have seen marked as spam millions of
   * times, and the brokerage needs the agent's reply, not our pitch.
   */
  const intro = handoffIntro(input.agentName);
  const textBody = `${intro}\n\n----------\n\n${own}`;
  const htmlBody =
    `<div style="color:#444">${plainTextToHtml(intro)}</div>` +
    `<hr style="border:0;border-top:1px solid #ddd;margin:14px 0">` +
    `<div>${plainTextToHtml(own)}</div>`;

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
    subject: handoffSubject(input.agentName),
    textBody,
    htmlBody,
    headers,
    metadata: { relay_id: input.relayId, thread_id: input.threadId },
  };
}
