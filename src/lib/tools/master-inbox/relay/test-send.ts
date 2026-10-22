import { buildRelayEmail, type RelayEmail } from "./message.ts";
import type { Recipient } from "./rules.ts";
import { isEmail } from "./settings.ts";

/*
 * TEST SENDS (user, 20 Oct): "we need to deploy this postmark work but do not
 * make this live. we need to test this properly with our own email address
 * like admin@outreachify.io. no testing with clients please".
 *
 * A test send goes to ONE address on TEST_RECIPIENTS and nowhere else — the
 * transport refuses anything else (postmark.ts sendTest). It is apart from the
 * relay's live path on purpose:
 *
 *   - it needs only the Postmark token, NOT OS_BROKERAGE_RELAY_LIVE_SEND, so
 *     testing never means switching the hand-off live;
 *   - it never changes a hand-off, never takes an agent's one-delivery slot,
 *     never counts against a brokerage's hourly cap — a test cannot stop a
 *     real hand-off from going later;
 *   - Reply-To is the test address and the threading headers are dropped, so
 *     answering a test copy can never reach the real agent;
 *   - the subject says [TEST] and the body says, first, who it would have gone to.
 */

export const TEST_RECIPIENTS: readonly string[] = ["admin@outreachify.io"];
/** Test sends a day, all admins together — a stuck button cannot flood the inbox. */
export const TEST_DAILY_CAP = 20;

/**
 * The fixed test address. Portal sign-in emails (portal-login/mail.ts) use
 * THIS, never the hand-off's settable list below — setting a hand-off test
 * address must not widen who can get a sign-in email.
 */
export function isTestRecipient(address: string | null | undefined): boolean {
  const a = String(address ?? "").trim().toLowerCase();
  return a.length > 0 && TEST_RECIPIENTS.includes(a);
}

/*
 * The hand-off's test address(es) can be set on its Settings page (23 Oct, the
 * user: "can we change this email address for testing? … give me an option to
 * set email address here"), within these limits, checked when saved AND again
 * at every send (relay.ts): our own domains or someone on Team access, never
 * an address on a brokerage's contact list, at most three. Until one is saved
 * (and before migration 0040), TEST_RECIPIENTS.
 */
export const TEST_DOMAINS: readonly string[] = ["outreachify.io", "brokerstaffer.com"];
export const MAX_TEST_RECIPIENTS = 3;

export interface TestAddressContext {
  /** Active Team access people. */
  team: ReadonlySet<string>;
  /** Every address on a brokerage's contact list (and any relay address override). */
  brokerage: ReadonlySet<string>;
}

/** Why an address cannot receive hand-off tests — or null when it can. */
export function testAddressRefusal(address: string, ctx: TestAddressContext): string | null {
  const a = address.trim().toLowerCase();
  if (!isEmail(a)) return `"${address.trim()}" is not an email address.`;
  if (ctx.brokerage.has(a)) return `${a} is on a brokerage's contact list — a test never goes to a brokerage.`;
  // The exact domain: leads.brokerstaffer.com or brokerstaffer.com.evil.com are not ours.
  if (TEST_DOMAINS.includes(a.slice(a.lastIndexOf("@") + 1)) || ctx.team.has(a)) return null;
  return `${a} is not one of ours — use an @outreachify.io or @brokerstaffer.com address, or someone on Team access.`;
}

/** The list a person typed (comma, semicolon or space separated), checked. */
export function parseTestRecipients(raw: unknown, ctx: TestAddressContext): { list: string[] } | { error: string } {
  const parts = (Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/[,;\s]+/)).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const list = [...new Set(parts)];
  if (!list.length) return { error: "Enter at least one address." };
  if (list.length > MAX_TEST_RECIPIENTS) return { error: `At most ${MAX_TEST_RECIPIENTS} addresses.` };
  for (const a of list) {
    const why = testAddressRefusal(a, ctx);
    if (why) return { error: why };
  }
  return { list };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const who = (r: Recipient) => (r.name ? `${r.name} <${r.email}>` : r.email);

/**
 * The email as a test: to `to` only, Reply-To `to`, no threading, [TEST] in the
 * subject, and a first paragraph naming who would have received it.
 */
export function asTest(email: Pick<RelayEmail, "fromName" | "fromAddress" | "from" | "subject" | "textBody" | "htmlBody">, to: string, note: { intended: Recipient[]; agentReplyTo: string | null; source: string }): RelayEmail {
  const addr = to.trim().toLowerCase();
  const intended = note.intended.length ? note.intended.map(who).join(", ") : "the brokerage's introduction contacts";
  const lines = [
    `TEST — sent only to ${addr}. ${note.source}`,
    `In live use this goes to: ${intended}.`,
    note.agentReplyTo ? `In live use, replies go to the agent: ${note.agentReplyTo}. Replies to this test come back to ${addr}.` : `Replies to this test come back to ${addr}.`,
  ];
  const banner = `<div style="margin:0 0 16px;padding:10px 12px;border:1px solid #f0c36d;background:#fff8e6;border-radius:6px;font:13px/1.5 -apple-system,Segoe UI,sans-serif;color:#5c4400">${lines.map((l) => esc(l)).join("<br>")}</div>`;
  return {
    fromName: email.fromName,
    fromAddress: email.fromAddress,
    from: email.from,
    to: [{ name: null, email: addr }],
    toHeader: addr,
    replyTo: addr,
    subject: `[TEST] ${email.subject.replace(/^\[TEST\]\s*/i, "")}`,
    textBody: `${lines.join("\n")}\n\n----\n\n${email.textBody}`,
    htmlBody: `${banner}${email.htmlBody}`,
    headers: [],
    metadata: { test: "1" },
  };
}

/** A sample hand-off with made-up words — no client's, no agent's data at all. */
export function sampleEmail(fromAddress: string, to: string, now = new Date()): RelayEmail {
  const sent = now.toISOString();
  const earlier = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const built = buildRelayEmail({
    relayId: "test-sample",
    threadId: "test-sample",
    fromAddress,
    agentName: "Sam Sample",
    replyTo: to,
    recipients: [{ name: "Sample Brokerage", email: to }],
    threadSubject: "Quick question about your next move",
    reply: {
      id: "sample-reply",
      direction: "inbound",
      sender: "sam.sample@example.com",
      senderName: "Sam Sample",
      subject: "Re: Quick question about your next move",
      bodyText: "Hi — thanks for reaching out. Yes, I'd be open to hearing more. I'm free Tuesday or Wednesday afternoon for a quick call; my cell is 555-0142.\n\nSam",
      bodyHtml: null,
      sentAt: sent,
    },
    messages: [
      {
        id: "sample-outreach",
        direction: "outbound",
        sender: "recruiting@example.com",
        senderName: "Nicole Collins",
        subject: "Quick question about your next move",
        bodyText: "Hi Sam,\n\nA brokerage in your area is growing its team and asked us to reach out. Would you be open to a short, confidential conversation?\n\nNicole",
        bodyHtml: null,
        sentAt: earlier,
      },
      {
        id: "sample-reply",
        direction: "inbound",
        sender: "sam.sample@example.com",
        senderName: "Sam Sample",
        subject: "Re: Quick question about your next move",
        bodyText: "Hi — thanks for reaching out. Yes, I'd be open to hearing more. I'm free Tuesday or Wednesday afternoon for a quick call; my cell is 555-0142.\n\nSam",
        bodyHtml: null,
        sentAt: sent,
      },
    ],
    agentMessageId: null,
  });
  return asTest(built, to, { intended: [], agentReplyTo: null, source: "A sample with made-up words — no client or agent data." });
}

/* The day's count of test sends, shared across Next bundles (globalThis), like the other in-memory caps. */
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const counter = ((globalThis as Record<string, unknown>).__relayTestSends ??= { day: "", n: 0 }) as { day: string; n: number };

/** Takes one of the day's test sends; false when the day's cap is reached. */
export function takeTestSend(now = Date.now()): boolean {
  if (counter.day !== day(now)) { counter.day = day(now); counter.n = 0; }
  if (counter.n >= TEST_DAILY_CAP) return false;
  counter.n += 1;
  return true;
}

/** For tests. */
export function resetTestSends(): void {
  counter.day = "";
  counter.n = 0;
}
