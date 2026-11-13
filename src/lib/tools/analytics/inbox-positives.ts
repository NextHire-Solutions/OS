/*
 * Replies and positive replies per inbox, from Master Inbox (14 Nov) — the
 * client: "add to Inboxes the domains and inboxes that get the most replies and
 * positive replies. Positive replies are always the ones we tag as Interested
 * on Master Inbox, not what Bison tags as Interested."
 *
 * WHY MASTER INBOX FOR THE REPLIES TOO. Every reply on both platforms lands
 * there, one conversation per lead and campaign. The platforms' own "Replied"
 * on this page cannot be set beside it: Instantly's is only what the sync has
 * stored (one inbox: 9 replied, 32 positive), so a rate over it was over 100%
 * on 274 inboxes, and ranking by it put every Instantly inbox last. Counted
 * from one place, a positive is always one of an inbox's replies.
 *
 * A REPLY is a conversation in Master Inbox — one per lead and campaign; each
 * exists because a lead replied — except one in Trash and one labelled only as
 * an out-of-office or automatic reply now. Master Inbox holds replies from May
 * 2026.
 *
 * A POSITIVE is a reply labelled Interested in Master Inbox, ever — by a person
 * or by Master Inbox's own AI labeller, which gave 443 of the 650 Interested
 * labels on record (14 Nov); EmailBison's flag is never read. Master Inbox keeps
 * one label per conversation, so introducing an Interested reply replaces its
 * "Interested" with "Introduction"; `label_history` (Master Inbox 0080) keeps
 * every label since, but before 14 Oct only the label each conversation
 * carried on 2 Nov is known. Measured 14 Nov: 629 conversations ever marked
 * Interested, and 1,430 more introduced with no Interested on record — the
 * team mostly introduced straight from the reply before then. So an
 * introduction counts too: every introduction is a reply the team judged
 * positive. One that carries a "no" label now is not positive (it is still a
 * reply), as pay-per-lead billing does not count it. A conversation can carry
 * more than one label (434 did on 14 Nov), so every label it carries is read.
 *
 * WHICH INBOX. The one the lead's FIRST reply was addressed to. A
 * conversation's `outbound_sender_email` follows the newest email we sent, so
 * after an introduction it names Nicole's inbox, which sends introductions —
 * 31% of positives and 4.7% of the other replies were elsewhere. The first
 * reply's "To" names the inbox for 98.9% of positives; the rest fall back to
 * the sender of our first email, then to the conversation's inbox.
 *
 * Pure: the loader (inbox-positives-load.ts) reads Master Inbox, the route
 * lays the counts over the inbox list.
 */

export type Platform = "emailbison" | "instantly";

/** The labels that make a conversation positive, as Master Inbox names them. */
export const POSITIVE_LABELS = ["Interested", "Introduction"] as const;

/**
 * A positive later corrected to one of these is not counted — the same list
 * pay-per-lead billing uses (usage-billing/leads.ts CORRECTION_LABELS; a test
 * keeps the two equal).
 */
export const CORRECTION_LABELS: ReadonlySet<string> = new Set(["Not Interested", "Not Qualified", "Do Not Contact", "Unsubscribe", "Broker/Owner"]);

/** Not a person's reply: an out-of-office, or a machine's. */
export const AUTOMATIC_LABELS: ReadonlySet<string> = new Set(["OOO", "OOO Sequence", "Automated Response"]);

/** An address as both platforms and Master Inbox can agree on it. */
export function normAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // "Nicole Collins <nicole@x.com>" as well as the bare address.
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  const a = (angled ? angled[1] : value).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(a) ? a : null;
}

/** The "To" addresses of a stored message (`messages.recipients`: `{ to, cc, bcc }`). */
export function toAddresses(recipients: unknown): string[] {
  const to = (recipients as { to?: unknown } | null)?.to;
  if (!Array.isArray(to)) return [];
  const out: string[] = [];
  for (const entry of to) {
    const raw = typeof entry === "string" ? entry : ((entry as { address?: unknown; email?: unknown } | null)?.address ?? (entry as { email?: unknown } | null)?.email);
    const a = normAddress(raw);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

export interface ThreadFacts {
  id: string;
  status: string | null;
  source_provider: string | null;
  outbound_sender_email: string | null;
}

export interface MessageFacts {
  thread_id: string;
  sender?: string | null;
  recipients?: unknown;
  sent_at: string | null;
}

const at = (m: MessageFacts) => (m.sent_at ? Date.parse(m.sent_at) : NaN);

/**
 * The earliest message of each conversation, from a list in any order. A
 * message with no time cannot be placed first and is passed over.
 */
export function earliestByThread(messages: Iterable<MessageFacts>): Map<string, MessageFacts> {
  const out = new Map<string, MessageFacts>();
  for (const m of messages) {
    const t = at(m);
    if (!Number.isFinite(t)) continue;
    const held = out.get(m.thread_id);
    if (!held || t < at(held)) out.set(m.thread_id, m);
  }
  return out;
}

/** A reply, with the addresses it may belong to (most likely first) and whether it is positive. */
export interface Conversation {
  threadId: string;
  platform: Platform | null;
  candidates: string[];
  positive: boolean;
}

const platformOf = (p: string | null): Platform | null => (p === "emailbison" || p === "instantly" ? p : null);

/**
 * Our addresses for one conversation, most likely first: whom the lead's first
 * reply went to, then who sent our first email, then the conversation's inbox.
 */
export function candidatesFor(thread: ThreadFacts, firstReply: MessageFacts | undefined, firstSent: MessageFacts | undefined): string[] {
  const out: string[] = [];
  const add = (a: string | null) => {
    if (a && !out.includes(a)) out.push(a);
  };
  for (const a of firstReply ? toAddresses(firstReply.recipients) : []) add(a);
  add(normAddress(firstSent?.sender));
  add(normAddress(thread.outbound_sender_email));
  return out;
}

/**
 * Every reply in Master Inbox, and which are positive.
 *
 * @param threads      every conversation (one read twice by the paging is counted once)
 * @param labelsNow    the labels each conversation carries now, by id
 * @param everPositive conversation ids ever given a POSITIVE_LABELS label
 * @param firstReply   each conversation's earliest inbound message
 * @param firstSent    each conversation's earliest outbound message, where read
 */
export function conversationsOf(
  threads: readonly ThreadFacts[],
  labelsNow: ReadonlyMap<string, readonly string[]>,
  everPositive: ReadonlySet<string>,
  firstReply: ReadonlyMap<string, MessageFacts>,
  firstSent: ReadonlyMap<string, MessageFacts>,
): Conversation[] {
  const out: Conversation[] = [];
  const seen = new Set<string>();
  for (const t of threads) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (t.status === "trash") continue;
    const now = labelsNow.get(t.id) ?? [];
    // Any "no" label corrects it, whatever else it carries — as billing reads it.
    const positive = everPositive.has(t.id) && !now.some((l) => CORRECTION_LABELS.has(l));
    // An out-of-office is not a reply — unless the lead had already been judged positive,
    // or the conversation also carries a person's label.
    if (!positive && now.length > 0 && now.every((l) => AUTOMATIC_LABELS.has(l))) continue;
    out.push({
      threadId: t.id,
      platform: platformOf(t.source_provider),
      candidates: candidatesFor(t, firstReply.get(t.id), firstSent.get(t.id)),
      positive,
    });
  }
  return out;
}

/** The key one inbox row is counted under. */
export const inboxKey = (platform: Platform, email: string) => `${platform}:${email.trim().toLowerCase()}`;

export interface Tally {
  replies: number;
  positive: number;
}

export interface Attribution {
  /** Replies and positives by `inboxKey`. An inbox with no reply is absent. */
  byInbox: Map<string, Tally>;
  /** Replies whose addresses are none of the inboxes listed. */
  unattributed: Tally;
  /** Replies through a platform whose inbox list could not be read. */
  unlisted: Tally;
}

/**
 * Counts each reply for one inbox: the first of its candidates that is an
 * inbox on the list. The same address can be an inbox on both platforms (one
 * mailbox connected to each); it counts on the platform the conversation came
 * through, and on the other only when its own platform has no such inbox.
 *
 * @param unavailable platforms whose inboxes could not be read. Their
 *   conversations are set aside, not moved onto the other platform's inbox
 *   with the same address — that would change numbers whenever a read failed.
 */
export function attributeReplies(
  conversations: readonly Conversation[],
  inboxes: ReadonlyArray<{ platform: Platform; email: string }>,
  unavailable: readonly Platform[] = [],
): Attribution {
  const platforms = new Map<string, Set<Platform>>();
  for (const i of inboxes) {
    const a = normAddress(i.email);
    if (!a) continue;
    const set = platforms.get(a) ?? new Set<Platform>();
    set.add(i.platform);
    platforms.set(a, set);
  }
  const byInbox = new Map<string, Tally>();
  const unattributed: Tally = { replies: 0, positive: 0 };
  const unlisted: Tally = { replies: 0, positive: 0 };
  const count = (t: Tally, c: Conversation) => {
    t.replies++;
    if (c.positive) t.positive++;
  };
  for (const c of conversations) {
    if (c.platform && unavailable.includes(c.platform)) {
      count(unlisted, c);
      continue;
    }
    const address = c.candidates.find((a) => platforms.has(a));
    if (!address) {
      count(unattributed, c);
      continue;
    }
    const on = platforms.get(address)!;
    const platform: Platform = c.platform && on.has(c.platform) ? c.platform : on.has("emailbison") ? "emailbison" : "instantly";
    const key = inboxKey(platform, address);
    const tally = byInbox.get(key) ?? { replies: 0, positive: 0 };
    count(tally, c);
    byInbox.set(key, tally);
  }
  return { byInbox, unattributed, unlisted };
}
