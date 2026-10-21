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
/*
 * Body phrases an out-of-office or a robot writes and an interested person
 * does not. Kept to unambiguous ones: "I'm travelling this week but yes,
 * call me" is a real reply and must not match. (Reviewed 17 Oct: added
 * "automated …", "limited access to email", "… upon my return" and "on
 * <kind of> leave". 21 Oct: "I am currently on vacation", "thank you for your
 * email … I am away / out", "away until … no access". "I'm away until Monday
 * but yes" alone is a person, and still does not match.)
 */
const AUTO_BODY = /\b(i am (currently )?(out of|away from) (the )?office|(i am|i'?m) currently on (vacation|holiday|pto|annual leave)|thank(s| you) for your (e-?mail|message)\b[^\n]{0,40}\b(i am|i'?m) (currently )?(away|out of|on (vacation|holiday|leave))|(i am|i'?m) (currently )?away until\b[^.\n]{0,60}\b(no|limited) access|i'?m (currently )?(out of|away from) (the )?office|i will be out of (the )?office|i am currently away|i'?m currently away|this is an (automatic(ally generated)?|automated) (reply|response|message)|this is an auto-?(reply|response)|auto-?generated (reply|response|message)|do not reply to this (email|message)|this mailbox is (not|no longer) (monitored|active)|delivery (has )?failed|message (could not|couldn't) be delivered|mailer-daemon|limited access to (my )?e-?mail|(respond|reply|get back to you)\b[^.\n]{0,40}\bupon my return|on (annual|maternity|paternity|parental|medical|sick|bereavement) leave)\b/i;
const SYSTEM_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|auto-?reply|autoresponder)([+.@-]|$)/i;

/** Curly apostrophes and quotes as straight ones: phones write "I’m out of the office" and "don’t contact" (21 Oct review). */
export const straightQuotes = (s: string | null | undefined) => String(s ?? "").replace(/[\u2018\u2019\u201B\u02BC\u2032]/g, "'").replace(/[\u201C\u201D\u201F\u2033]/g, '"');

export function looksAutomatic(subject: string | null | undefined, ownText: string | null | undefined, sender: string | null | undefined): boolean {
  if (SYSTEM_SENDER.test((sender ?? "").trim())) return true;
  if (AUTO_SUBJECT.test(straightQuotes(subject))) return true;
  return AUTO_BODY.test(straightQuotes(ownText));
}

/*
 * The reply agent's opt-out list (ai/safety.ts, shared — left as it is), plus
 * a few the relay adds for itself: unambiguous ways to say "stop". Hand-offs
 * err towards not sending.
 */
const MORE_OPT_OUT = /\b(stop (messaging|sending|e-?mailing) me|(do not|don'?t) (e-?mail|message|reach out to) me|leave me alone|no more e-?mails)\b/i;

export function looksLikeOptOut(ownText: string | null | undefined): boolean {
  const t = straightQuotes(ownText);
  return looksLikeUnsubscribe(t) || MORE_OPT_OUT.test(t);
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
  // Before stripQuoted (which keeps a lone "From:" once it has cut the lines that identify it) and after it.
  return trimReplyHeader(stripQuoted(trimReplyHeader(raw.replace(/\r\n/g, "\n")))).replace(/\n{3,}/g, "\n\n").trim();
}

/*
 * What stripQuoted (shared with the phone finder, so left as it is) can leave
 * under a SHORT reply: the header a mail client writes above the quote.
 * Gmail wraps "On Mon, Oct 5, 2026 at 10:42 AM Nicole Collins <" and
 * "nicole.c@…> wrote:" over two lines, and Outlook's "From: … / Sent: …"
 * block survives when the reply above it is under three lines. Either would
 * put our cold-email sender's address into the brokerage's copy, as if the
 * agent had written it. Everything from such a header down is dropped.
 */
export function trimReplyHeader(text: string): string {
  const lines = text.split("\n");
  const cutAt = (i: number) => lines.slice(0, i).join("\n").trimEnd();
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^on\s/i.test(t)) {
      for (let j = i; j < Math.min(lines.length, i + 3); j++) {
        const joined = lines.slice(i, j + 1).map((l) => l.trim()).join(" ");
        if (/wrote:\s*$/i.test(lines[j].trim()) && /^on\s.{4,300}\swrote:$/i.test(joined)) return cutAt(i);
      }
    }
    const ahead = lines.slice(i + 1, i + 5).map((l) => l.trim());
    if (/^_{8,}$/.test(t) && ahead.slice(0, 3).some((l) => /^from:\s/i.test(l))) return cutAt(i);
    if (/^from:\s+\S/i.test(t) && ahead.some((l) => /^(sent|date|to|subject|cc):\s/i.test(l))) return cutAt(i);
  }
  return text;
}

/*
 * The agent's reply must be this recent when it was labelled. Older means an
 * old conversation being labelled again — an AI re-label of the workspace, or
 * a tidy-up — not an agent waiting for an answer now; "no backfill" is about
 * the reply, not only the label. Such a conversation is never handed off by
 * itself (the team can still introduce by hand).
 */
export const REPLY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function isStaleReply(replySentAt: string | null | undefined, at: string | Date | null | undefined): boolean {
  const sent = replySentAt ? Date.parse(replySentAt) : NaN;
  if (!Number.isFinite(sent)) return true; // no date: cannot show it is recent
  const ref = at instanceof Date ? at.getTime() : at ? Date.parse(at) : NaN;
  if (!Number.isFinite(ref)) return false;
  return ref - sent > REPLY_MAX_AGE_MS;
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
 * never the one handed over. Of those, the newest a PERSON wrote (21 Oct
 * review): an out-of-office, or an empty one, after the real "yes" is not the
 * reply that was marked. Only when every one is automatic or empty is the
 * newest taken — and then skipped as such.
 */
export function pickAgentReply(messages: MessageFacts[], lead: LeadFacts, triggeredAt: string | null): MessageFacts | null {
  const mine = messages
    .filter((m) => isFromAgent(m, lead))
    .sort((a, b) => String(a.sentAt ?? "").localeCompare(String(b.sentAt ?? "")));
  if (!mine.length) return null;
  const cutoff = triggeredAt ? Date.parse(triggeredAt) + LABEL_GRACE_MS : NaN;
  const before = Number.isFinite(cutoff) ? mine.filter((m) => m.sentAt && Date.parse(m.sentAt) <= cutoff) : [];
  const pool = before.length ? before : mine;
  const written = pool.filter((m) => {
    const own = ownText(m);
    return own !== "" && !looksAutomatic(m.subject, own, m.sender);
  });
  return (written.length ? written : pool).at(-1) ?? null;
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
 * A DNC domain as the DNC tool reads it — the same rules as
 * portals/enforce-blocklist.ts normalizeDomain (kept apart because that module
 * brings the EmailBison and Instantly clients with it): no protocol, no "@",
 * no "www.", nothing after a slash, and it must look like a domain.
 * "https://www.KW.com/team" → "kw.com".
 */
export function dncDomain(raw: string | null | undefined): string | null {
  let v = String(raw ?? "").trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^@/, "").replace(/^www\./, "");
  v = v.split("/")[0] ?? v;
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(v) ? v : null;
}

/*
 * The domain an entry blocks. In the DNC tool a COMPANY entry blocks a domain
 * (it is pushed to the providers' domain blocklists) and an AGENT entry
 * blocks an address — an agent entry's domain field is not a block, and
 * reading it as one would stop every agent at gmail.com for that brokerage.
 * An entry of no stated kind is read by what it holds: a domain and no
 * address is a company.
 */
function blockedDomain(e: DncEntry): string | null {
  const kind = (e.kind ?? "").trim().toLowerCase();
  if (kind === "agent") return null;
  if (kind !== "company" && normEmail(e.email)) return null;
  return dncDomain(e.domain);
}

/*
 * On the brokerage's DNC list by address (any of the agent's), by company
 * domain (a sub-domain counts), or by full name on any person's entry —
 * with an address or without (68% carry none). An entry's address is not the
 * only one that person writes from (21 Oct review), and a name match is the
 * cautious reading: a miss sends to someone the brokerage said not to. Names compare
 * the way the DNC tool's own stop does (sameName: first and last name, case,
 * accents and suffixes like "Jr." ignored).
 *
 * The caller passes the brokerage's WHOLE list — a pre-filtered page could
 * leave out the one entry that matches.
 */
export function dncHit(entries: DncEntry[], agent: { emails: string[]; name: string | null }): DncHit {
  const emails = new Set(agent.emails.map(normEmail).filter(Boolean));
  const domains = new Set(agent.emails.flatMap((e) => domainAndParents(emailDomain(e))));
  for (const e of entries) {
    const em = normEmail(e.email);
    if (em && emails.has(em)) return { by: "email", entry: em };
  }
  for (const e of entries) {
    const d = blockedDomain(e);
    if (d && domains.has(d)) return { by: "domain", entry: d };
  }
  for (const e of entries) {
    if ((e.kind ?? "").trim().toLowerCase() === "company") continue;
    if (e.name && sameName(e.name, agent.name)) return { by: "name", entry: e.name };
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
