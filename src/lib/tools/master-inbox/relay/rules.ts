import { sameName } from "../portals/stop-person-plan.ts";
import { looksLikeUnsubscribe } from "../ai/safety.ts";
import { stripQuoted } from "../ai/lead-phone.ts";
import { introContacts, routeIntro, type IntroMacroClient, type IntroRoute } from "../inbox/intro-macro.ts";

import { isEmail, type BrokerageRelaySettings } from "./settings.ts";

/*
 * The checks before any hand-off (plan §3 "It is checked", §4 safeguards).
 * Pure: the caller loads the conversation and the brokerage's lists, these
 * decide. A check that fails HOLDS (waits for something to change: the team
 * to assign a campaign, a contact to be added, the hour to pass) or SKIPS
 * (never sent for this conversation).
 */

/** The labels that start a hand-off: "Interested", and "Meetings Booked" counts too (plan §3.2). */
export const TRIGGER_LABELS = ["interested", "meetings booked"] as const;

export function isTriggerLabel(name: string | null | undefined): boolean {
  return (TRIGGER_LABELS as readonly string[]).includes((name ?? "").trim().toLowerCase());
}

/*
 * Labels that mean "do not hand this person over", whatever else the
 * conversation carries: the stop-contact family (stop-person-plan's), the
 * auto-reply categories the AI labeller uses, and a decline.
 */
const STOP_LABELS = new Set([
  "hostile",
  "unsubscribe",
  "do not contact",
  "add to blocklist",
  "not interested",
  "ooo sequence",
  "automated response",
  "wrong person",
]);

export function stopLabel(names: string[]): string | null {
  return names.find((n) => STOP_LABELS.has(n.trim().toLowerCase())) ?? null;
}

/** Already introduced by hand: the Introduction label is the team's own hand-off. */
export function hasIntroductionLabel(names: string[]): boolean {
  return names.some((n) => n.trim().toLowerCase() === "introduction");
}

/*
 * An out-of-office or automatic reply (plan §4: "Never for out-of-office or
 * automatic replies"). The subject and the agent's own words are read; the
 * quoted email under them is not, since it is ours.
 */
const AUTO_SUBJECT = /\b(out of (the )?office|automatic reply|auto-?reply|autoreply|auto response|away from (the )?office|on vacation|on leave|out of town|delivery status notification|undeliver(able|ed)|mail delivery (failed|subsystem)|returned mail|read receipt)\b/i;
const AUTO_BODY = /\b(i am (currently )?(out of|away from) (the )?office|i'?m (currently )?(out of|away from) (the )?office|i will be out of (the )?office|i am currently away|i'?m currently away|this is an automatic(ally generated)? (reply|response|message)|this is an auto-?(reply|response)|auto-?generated (reply|response|message)|do not reply to this (email|message)|this mailbox is (not|no longer) (monitored|active)|delivery (has )?failed|message (could not|couldn't) be delivered|mailer-daemon)\b/i;
const SYSTEM_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|auto-?reply|autoresponder)([+.@-]|$)/i;

export function looksAutomatic(subject: string | null | undefined, ownText: string | null | undefined, sender: string | null | undefined): boolean {
  if (SYSTEM_SENDER.test((sender ?? "").trim())) return true;
  if (AUTO_SUBJECT.test(subject ?? "")) return true;
  return AUTO_BODY.test(ownText ?? "");
}

export function looksLikeOptOut(ownText: string | null | undefined): boolean {
  return looksLikeUnsubscribe(ownText);
}

export const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

export function emailDomain(e: string | null | undefined): string | null {
  const a = normEmail(e);
  const at = a.lastIndexOf("@");
  return at > 0 ? a.slice(at + 1) : null;
}

/** "mail.kw.com" → ["mail.kw.com", "kw.com"] — a company entry for kw.com covers its sub-domains. */
export function domainAndParents(domain: string | null): string[] {
  if (!domain) return [];
  const parts = domain.split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i <= parts.length - 2; i++) out.push(parts.slice(i).join("."));
  return out;
}

export interface MessageFacts {
  id: string;
  direction: "inbound" | "outbound";
  sender: string | null;
  senderName: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  sentAt: string | null;
}

export interface LeadFacts {
  id: string | null;
  fullName: string | null;
  email: string | null;
}

/** The message's own words: HTML converted when there is no text, quoted history removed. */
export function ownText(m: Pick<MessageFacts, "bodyText" | "bodyHtml">): string {
  const raw = (m.bodyText ?? "").trim() ? String(m.bodyText) : htmlToText(m.bodyHtml ?? "");
  return stripQuoted(raw.replace(/\r\n/g, "\n")).replace(/\n{3,}/g, "\n\n").trim();
}

/** HTML → readable text. Quoted blocks (blockquote, Gmail/Outlook quote containers) are dropped first. */
export function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<div[^>]*class="[^"]*(gmail_quote|OutlookMessageHeader|yahoo_quoted)[^"]*"[\s\S]*$/i, "")
    .replace(/<div[^>]*id="(divRplyFwdMsg|appendonsend)"[\s\S]*$/i, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&rsquo;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Did the agent write this message? By address, or — when they replied from another one — by full name. */
export function isFromAgent(m: MessageFacts, lead: LeadFacts): boolean {
  if (m.direction !== "inbound") return false;
  const leadEmail = normEmail(lead.email);
  if (!leadEmail) return true; // no address on record: every inbound is the agent's
  if (normEmail(m.sender) === leadEmail) return true;
  return sameName(lead.fullName, m.senderName);
}

/** Small grace: a label applied a moment before the message row is written still finds it. */
const LABEL_GRACE_MS = 2 * 60 * 1000;

/**
 * The agent's reply that was marked: the newest message from the agent at or
 * before the label, else the newest from the agent at all. Messages from
 * anyone else (the client's own staff reply on introduced conversations) are
 * never the one handed over.
 */
export function pickAgentReply(messages: MessageFacts[], lead: LeadFacts, triggeredAt: string | null): MessageFacts | null {
  const mine = messages
    .filter((m) => isFromAgent(m, lead))
    .sort((a, b) => String(a.sentAt ?? "").localeCompare(String(b.sentAt ?? "")));
  if (!mine.length) return null;
  const cutoff = triggeredAt ? Date.parse(triggeredAt) + LABEL_GRACE_MS : NaN;
  if (Number.isFinite(cutoff)) {
    const before = mine.filter((m) => m.sentAt && Date.parse(m.sentAt) <= cutoff);
    if (before.length) return before[before.length - 1];
  }
  return mine[mine.length - 1];
}

/** The agent's address for the once-per-agent rule: the lead record's, else the reply's sender. */
export function agentEmailOf(lead: LeadFacts, reply: MessageFacts | null): string | null {
  const a = normEmail(lead.email) || normEmail(reply?.sender);
  return isEmail(a) ? a : null;
}

/** Where the brokerage's reply goes: the address the agent actually wrote from (plan §2). */
export function replyToOf(lead: LeadFacts, reply: MessageFacts): string | null {
  const from = normEmail(reply.sender);
  if (isEmail(from) && !SYSTEM_SENDER.test(from)) return from;
  const rec = normEmail(lead.email);
  return isEmail(rec) ? rec : null;
}

/* ------------------------------------------------------------------------ */
/* Do Not Contact — the brokerage's own list (client_dnc_entries).          */

export interface DncEntry {
  kind: string | null;
  name: string | null;
  email: string | null;
  domain: string | null;
}

export type DncHit = { by: "email" | "domain" | "name"; entry: string } | null;

/*
 * On the brokerage's DNC list by address (any of the agent's), by company
 * domain (company entries; a sub-domain counts), or by full name (name-only
 * entries — 68% of all entries carry no address, and a name match is the
 * cautious reading: a miss sends to someone the brokerage said not to).
 */
export function dncHit(entries: DncEntry[], agent: { emails: string[]; name: string | null }): DncHit {
  const emails = new Set(agent.emails.map(normEmail).filter(Boolean));
  const domains = new Set(agent.emails.flatMap((e) => domainAndParents(emailDomain(e))));
  for (const e of entries) {
    const em = normEmail(e.email);
    if (em && emails.has(em)) return { by: "email", entry: em };
  }
  for (const e of entries) {
    const d = (e.domain ?? "").trim().toLowerCase().replace(/^@/, "");
    if (d && domains.has(d)) return { by: "domain", entry: d };
  }
  for (const e of entries) {
    if (!normEmail(e.email) && e.name && sameName(e.name, agent.name)) return { by: "name", entry: e.name };
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* Recipients — the people introductions go to today, by territory.         */

export interface Recipient {
  name: string | null;
  email: string;
}

export interface RecipientPlan {
  recipients: Recipient[];
  /** How they were chosen, for the record. */
  via: "address" | "intro_contacts";
  route: IntroRoute | null;
}

/*
 * Plan §3.4: "The same people introductions go to today, by market — a
 * Charleston agent goes to the Charleston contacts. A brokerage can also have
 * one address of its own for these." routeIntro is the Introduce button's own
 * routing, so the two can never disagree about who covers a territory.
 * People without an address cannot receive anything and are left out; the
 * agent is never sent their own reply.
 */
export function planRecipients(
  settings: BrokerageRelaySettings,
  client: IntroMacroClient,
  campaignName: string | null,
  agentEmails: string[],
): RecipientPlan {
  const exclude = new Set(agentEmails.map(normEmail));
  if (settings.recipients === "address" && isEmail(settings.address) && !exclude.has(normEmail(settings.address))) {
    return { recipients: [{ name: null, email: normEmail(settings.address) }], via: "address", route: null };
  }
  const { client: routed, route } = routeIntro(client, campaignName);
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  for (const c of introContacts(routed)) {
    const email = normEmail(c.email);
    if (!isEmail(email) || exclude.has(email) || seen.has(email)) continue;
    seen.add(email);
    recipients.push({ name: (c.name ?? "").trim() || null, email });
  }
  return { recipients, via: "intro_contacts", route };
}

/* ------------------------------------------------------------------------ */

/** Statuses a brokerage must have to receive anything: active only (plan §4 — not paused or churned). */
export function isActiveStatus(status: string | null | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "active";
}

/** Never sent to, whatever its status (it backs the live demo portal and is never counted). */
export function isExcludedBrokerage(...names: Array<string | null | undefined>): boolean {
  return names.some((n) => (n ?? "").trim().toLowerCase() === "demo portal");
}

/** Statuses that use up the hourly cap: what went (or, in practice, would have gone). */
export const CAP_STATUSES = ["practice", "sending", "sent", "bounced"] as const;

/** How long a held hand-off may still go once what held it is resolved. Older ones are skipped. */
export const HOLD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
