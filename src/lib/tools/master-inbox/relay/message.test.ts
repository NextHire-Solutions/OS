/*
 * What the brokerage receives (plan §2), and the Postmark transport's locks.
 * No test reaches Postmark: the transport is given a fake fetch, and the
 * tests that matter assert that fetch is never even called.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addressHeader,
  agentDisplayName,
  buildRelayEmail,
  cleanDisplayName,
  messageIdFromPayload,
  providerSaysAutomatic,
  quotedHistory,
  relaySubject,
  type RelayEmail,
} from "./message.ts";
import { bounceKind, createPostmarkTransport, fetchBounces, postmarkPayload, POSTMARK_API } from "./postmark.ts";
import type { MessageFacts } from "./rules.ts";

const m = (over: Partial<MessageFacts>): MessageFacts => ({
  id: "m",
  direction: "inbound",
  sender: "jordan.ellis@coastalrealty.test",
  senderName: "Jordan Ellis",
  subject: "Re: Quick question, Jordan",
  bodyText: "",
  bodyHtml: null,
  sentAt: "2026-10-06T14:00:00.000Z",
  ...over,
});

const conversation: MessageFacts[] = [
  m({ id: "o1", direction: "outbound", sender: "nicole.c@brokerstaffer.com", senderName: "Nicole Collins", subject: "Quick question, Jordan", bodyText: "Hi Jordan, I came across your listings in Charlotte and wanted to ask…", sentAt: "2026-10-05T14:00:00.000Z" }),
  m({
    id: "r1",
    bodyText: "Sure, happy to chat. Mornings work best for me — (843) 555-0142.\n— Jordan\n\nOn Mon, Oct 5, 2026 at 10:00 AM Nicole Collins <nicole.c@brokerstaffer.com> wrote:\n> Hi Jordan, I came across your listings",
    sentAt: "2026-10-06T14:00:00.000Z",
  }),
  m({ id: "later", bodyText: "Also free Thursday.", sentAt: "2026-10-07T14:00:00.000Z" }),
];

function build(over: Partial<Parameters<typeof buildRelayEmail>[0]> = {}): RelayEmail {
  return buildRelayEmail({
    relayId: "rel-1",
    threadId: "th-1",
    fromAddress: "agents@leads.brokerstaffer.com",
    agentName: "Jordan Ellis",
    replyTo: "jordan.ellis@coastalrealty.test",
    recipients: [{ name: "Angela Oakes", email: "angela@brokerage.test" }],
    threadSubject: "Quick question, Jordan",
    reply: conversation[1],
    messages: conversation,
    agentMessageId: null,
    ...over,
  });
}

test("From is '<Agent> via BrokerStaffer' on leads.brokerstaffer.com; Reply-To is the agent; To is the brokerage", () => {
  const e = build();
  assert.equal(e.from, '"Jordan Ellis via BrokerStaffer" <agents@leads.brokerstaffer.com>');
  assert.equal(e.replyTo, '"Jordan Ellis" <jordan.ellis@coastalrealty.test>');
  assert.equal(e.toHeader, '"Angela Oakes" <angela@brokerage.test>');
  assert.equal(e.subject, "Re: Quick question, Jordan");
});

test("the body is the agent's reply first — nothing on top — then the earlier messages quoted", () => {
  const e = build();
  assert.ok(e.textBody.startsWith("Sure, happy to chat. Mornings work best for me — (843) 555-0142.\n— Jordan\n\n"), e.textBody);
  assert.match(e.textBody, /On Mon, Oct 5, 2026, 10:00 AM, Nicole Collins wrote:\n> Hi Jordan, I came across your listings in Charlotte/);
  // The agent's own quoting of our email is not repeated, and a LATER message is never included.
  assert.equal(e.textBody.match(/I came across your listings/g)?.length, 1);
  assert.doesNotMatch(e.textBody, /Also free Thursday/);
  assert.ok(e.htmlBody.startsWith("<div><p>Sure, happy to chat."), e.htmlBody);
  assert.match(e.htmlBody, /<div class="gmail_quote">.*<blockquote/);
  // No tracking, nothing added: the HTML is the agent's text and the quote, escaped.
  assert.doesNotMatch(e.htmlBody, /<img|<script|unsubscribe/i);
});

test("quoted: only messages before the reply, newest first — never the reply itself or anything later", () => {
  const first = m({ id: "o0", direction: "outbound", bodyText: "First touch", sentAt: "2026-10-01T00:00:00.000Z" });
  const q = quotedHistory([...conversation, first], conversation[1]);
  assert.deepEqual(q.map((x) => x.id), ["o1", "o0"]);
});

test("the agent's words are escaped in HTML, so a reply cannot inject markup", () => {
  const e = build({ reply: m({ id: "r1", bodyText: "<b>hi</b> & <script>alert(1)</script>", sentAt: "2026-10-06T14:00:00.000Z" }) });
  assert.match(e.htmlBody, /&lt;b&gt;hi&lt;\/b&gt; &amp; &lt;script&gt;/);
  assert.doesNotMatch(e.htmlBody, /<script>/);
});

test("display names cannot break the header or pass for an address", () => {
  assert.equal(cleanDisplayName('Jordan "JE" Ellis\r\nBcc: x@y.test'), "Jordan JE Ellis Bcc: x");
  assert.equal(cleanDisplayName("ceo@bank.test"), "ceo");
  assert.equal(cleanDisplayName("Jordan Ellis <jordan@x.test>"), "Jordan Ellis");
  const e = build({ agentName: 'Evil"\r\nX-Injected: 1' });
  assert.equal(e.from, '"Evil X-Injected: 1 via BrokerStaffer" <agents@leads.brokerstaffer.com>');
  assert.doesNotMatch(e.from, /[\r\n]/);
  assert.equal(addressHeader(null, "a@b.test"), "a@b.test");
  assert.equal(agentDisplayName({ id: null, fullName: null, email: "jordan.ellis@x.test" }, null), "Jordan Ellis");
});

test("subject: exactly one Re:, from the conversation's subject", () => {
  assert.equal(relaySubject("Re: RE: Fwd: Quick question", null), "Re: Quick question");
  assert.equal(relaySubject(null, "Re: Hello"), "Re: Hello");
  assert.equal(relaySubject("Line\r\nBreak", null), "Re: Line Break");
  assert.equal(relaySubject("", ""), "Re: (no subject)");
});

test("threads into the agent's own conversation when the provider gave the Message-ID", () => {
  assert.equal(messageIdFromPayload({ data: { reply: { raw_message_id: "<CAB123@mail.gmail.com>" } } }), "<CAB123@mail.gmail.com>");
  // An Instantly email object (what sync/instantly.ts stores for a synced email).
  assert.equal(messageIdFromPayload({ id: "e1", message_id: "abc@x.test", ue_type: 2, eaccount: "nicole@b.test" }), "<abc@x.test>");
  assert.equal(messageIdFromPayload({ data: { reply: { id: 99 } } }), null);
  assert.equal(messageIdFromPayload({ id: "e1", message_id: "not an id", ue_type: 2 }), null);
  const e = build({ agentMessageId: "<CAB123@mail.gmail.com>" });
  assert.deepEqual(e.headers, [
    { Name: "In-Reply-To", Value: "<CAB123@mail.gmail.com>" },
    { Name: "References", Value: "<CAB123@mail.gmail.com>" },
  ]);
  assert.deepEqual(build().headers, []);
});

test("Postmark payload: tracking off, metadata to find it again", () => {
  const p = postmarkPayload(build(), "outbound");
  assert.equal(p.TrackOpens, false);
  assert.equal(p.TrackLinks, "None");
  assert.equal(p.MessageStream, "outbound");
  assert.deepEqual(p.Metadata, { relay_id: "rel-1", thread_id: "th-1" });
  assert.equal(p.From, '"Jordan Ellis via BrokerStaffer" <agents@leads.brokerstaffer.com>');
});

/* ------------------------------------------------------------------ transport */

function spyFetch(answer: { status: number; body: unknown } = { status: 200, body: { ErrorCode: 0, MessageID: "pm-1", SubmittedAt: "x" } }) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

test("THE DEFAULT: with OS_BROKERAGE_RELAY_LIVE_SEND unset, the transport refuses and makes no request at all", async () => {
  const { f, calls } = spyFetch();
  const t = createPostmarkTransport({ fetch: f, env: { POSTMARK_SERVER_TOKEN: "server-token-test" } });
  const r = await t.send(build());
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.gated, "live_send_off");
  assert.equal(calls.length, 0);
  for (const v of ["true", "yes", "0", ""]) {
    const again = await createPostmarkTransport({ fetch: f, env: { OS_BROKERAGE_RELAY_LIVE_SEND: v, POSTMARK_SERVER_TOKEN: "t" } }).send(build());
    assert.equal(!again.ok && again.gated, "live_send_off", `"${v}" is not "1"`);
  }
  assert.equal(calls.length, 0);
});

test("the transport also refuses without a token, with a From off the relay domain, or with nobody to send to", async () => {
  const { f, calls } = spyFetch();
  const live = { OS_BROKERAGE_RELAY_LIVE_SEND: "1" };
  assert.equal((await createPostmarkTransport({ fetch: f, env: live }).send(build())).ok, false);
  const withToken = { ...live, POSTMARK_SERVER_TOKEN: "server-token-test" };
  const bad = await createPostmarkTransport({ fetch: f, env: withToken }).send(build({ fromAddress: "nicole.c@brokerstaffer.com" }));
  assert.equal(!bad.ok && bad.gated, "bad_from");
  const nobody = await createPostmarkTransport({ fetch: f, env: withToken }).send(build({ recipients: [] }));
  assert.equal(!nobody.ok && nobody.gated, "no_recipients");
  assert.equal(calls.length, 0);
});

test("with every lock open the request is Postmark's /email with the token in its header only (fake fetch — nothing leaves)", async () => {
  const { f, calls } = spyFetch();
  const r = await createPostmarkTransport({ fetch: f, env: { OS_BROKERAGE_RELAY_LIVE_SEND: "1", POSTMARK_SERVER_TOKEN: "server-token-test" } }).send(build());
  assert.deepEqual(r, { ok: true, messageId: "pm-1", submittedAt: "x" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${POSTMARK_API}/email`);
  assert.equal(new Headers(calls[0].init?.headers).get("x-postmark-server-token"), "server-token-test");
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.ReplyTo, '"Jordan Ellis" <jordan.ellis@coastalrealty.test>');
  assert.doesNotMatch(String(calls[0].init?.body), /server-token-test/);
});

test("a refusal is definite; a dropped connection is not (it may have been sent — never retried by itself)", async () => {
  const env = { OS_BROKERAGE_RELAY_LIVE_SEND: "1", POSTMARK_SERVER_TOKEN: "server-token-test" };
  const refused = await createPostmarkTransport({ fetch: spyFetch({ status: 422, body: { ErrorCode: 406, Message: "Inactive recipient" } }).f, env }).send(build());
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.definite, true);
  assert.match(!refused.ok ? refused.error : "", /Inactive recipient/);
  assert.doesNotMatch(!refused.ok ? refused.error : "", /server-token-test/);
  const dropped = await createPostmarkTransport({ fetch: (async () => { throw new Error("socket hang up"); }) as typeof fetch, env }).send(build());
  assert.equal(!dropped.ok && dropped.definite, false);
});

test("bounces are a read (GET /bounces), and need the token", async () => {
  const { f, calls } = spyFetch({ status: 200, body: { Bounces: [{ ID: 1, Type: "HardBounce", MessageID: "pm-1", Email: "a@b.test" }], TotalCount: 1 } });
  assert.equal((await fetchBounces(new Date("2026-10-10T00:00:00.000Z"), { fetch: f, env: {} })).ok, false);
  const r = await fetchBounces(new Date("2026-10-10T00:00:00.000Z"), { fetch: f, env: { POSTMARK_SERVER_TOKEN: "t" } });
  assert.equal(r.ok && r.bounces.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].url, `${POSTMARK_API}/bounces?count=500&offset=0&fromdate=2026-10-10`);
});

/* ------------------------------------------------------------------ review fixes (17 Oct) */

const LIVE_ENV = { OS_BROKERAGE_RELAY_LIVE_SEND: "1", POSTMARK_SERVER_TOKEN: "server-token-test" };

test("only a 4xx is a definite refusal; a 5xx or an unreadable 2xx may have been sent (review fix)", async () => {
  const send = (status: number, body: unknown) => createPostmarkTransport({ fetch: spyFetch({ status, body }).f, env: LIVE_ENV }).send(build());
  const fiveHundred = await send(500, { ErrorCode: 0, Message: "Internal" });
  assert.equal(!fiveHundred.ok && fiveHundred.definite, false, "500: Postmark may have accepted it");
  const garbled = await send(200, "<html>proxy page</html>");
  assert.equal(!garbled.ok && garbled.definite, false, "200 with no MessageID: unknown, never 'refused'");
  const tooMany = await send(429, { ErrorCode: 429, Message: "Rate limit" });
  assert.equal(!tooMany.ok && tooMany.definite, true);
  const badToken = await send(401, { ErrorCode: 10, Message: "Bad or missing API token" });
  assert.equal(!badToken.ok && badToken.definite, true);
});

test("every page of bounces is read — a capped first page is not the whole list (review fix)", async () => {
  const calls: string[] = [];
  const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ ID: from + i, Type: "HardBounce", MessageID: `pm-${from + i}`, Email: "a@b.test" }));
  const f = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    const offset = Number(new URL(String(url)).searchParams.get("offset"));
    const rows = offset === 0 ? page(500, 0) : page(3, 500);
    return new Response(JSON.stringify({ Bounces: rows, TotalCount: 503 }), { status: 200 });
  }) as typeof fetch;
  const r = await fetchBounces(new Date("2026-10-10T00:00:00.000Z"), { fetch: f, env: { POSTMARK_SERVER_TOKEN: "t" } });
  assert.equal(r.ok && r.bounces.length, 503);
  assert.deepEqual(calls.map((u) => new URL(u).searchParams.get("offset")), ["0", "500"]);
  const endless = (async () => new Response(JSON.stringify({ Bounces: page(500, 0), TotalCount: 99999 }), { status: 200 })) as typeof fetch;
  const capped = await fetchBounces(new Date("2026-10-10T00:00:00.000Z"), { fetch: endless, env: { POSTMARK_SERVER_TOKEN: "t" } });
  assert.equal(capped.ok, false, "too many to read in full is an error, not a silent cut");
});

test("the Message-ID is the REPLY's own — never our scheduled email's or the lead's, never made up (review fix)", () => {
  // The EmailBison webhook carries our outreach (scheduled_email) beside the reply; its id used to be reachable first.
  const envelope = {
    event: { type: "LEAD_REPLIED" },
    data: {
      lead: { id: 5, email: "jordan@coastal.test" },
      scheduled_email: { id: 7, raw_message_id: "<our-outreach@bison.test>" },
      reply: { id: 9, raw_message_id: "<agent-reply@mail.gmail.com>", automated_reply: false },
    },
  };
  assert.equal(messageIdFromPayload(envelope), "<agent-reply@mail.gmail.com>");
  const noReplyId = { ...envelope, data: { ...envelope.data, reply: { id: 9 } } };
  assert.equal(messageIdFromPayload(noReplyId), null, "the scheduled email's id is not the agent's");
  // The wrapped test-event shape, and the conversation-thread reply object itself.
  assert.equal(messageIdFromPayload({ data: { event: {}, data: { reply: { raw_message_id: "w@x.test" } } } }), "<w@x.test>");
  assert.equal(messageIdFromPayload({ id: 9, raw_message_id: "c@x.test", from_email_address: "jordan@coastal.test" }), "<c@x.test>");
  // An Instantly webhook carries no Message-ID: no headers rather than a guess.
  assert.equal(messageIdFromPayload({ event_type: "reply_received", email_id: "u-1", lead_email: "jordan@coastal.test" }), null);
  assert.equal(messageIdFromPayload(null), null);
});

test("EmailBison's own 'automatic reply' flag is read from the reply (review fix)", () => {
  assert.equal(providerSaysAutomatic({ data: { reply: { id: 1, automated_reply: true } } }), true);
  assert.equal(providerSaysAutomatic({ id: 1, raw_message_id: "a@b.test", automated_reply: true }), true);
  assert.equal(providerSaysAutomatic({ data: { reply: { id: 1, automated_reply: false } } }), false);
  assert.equal(providerSaysAutomatic({ data: { scheduled_email: { automated_reply: true }, reply: { id: 1 } } }), false, "only the reply's own flag");
  assert.equal(providerSaysAutomatic(undefined), false);
});

test("subject: control characters never reach the header, and a runaway subject is cut at a word (review fix)", () => {
  assert.equal(relaySubject("Quick\u0000question\u0007\tJordan", null), "Re: Quick question Jordan");
  const long = relaySubject(`${"word ".repeat(80)}end`, null);
  assert.ok(long.length <= 205, String(long.length));
  assert.match(long, /^Re: word word .* word…$/);
});

test("an out-of-office or a delay is not a bounce; a spam report is its own kind (review fix)", () => {
  for (const t of ["AutoResponder", "Transient", "AddressChange", "Subscribe", "ChallengeVerification", "OpenRelayTest"]) assert.equal(bounceKind(t), "ignore", t);
  for (const t of ["SpamComplaint", "SpamNotification"]) assert.equal(bounceKind(t), "spam", t);
  for (const t of ["HardBounce", "SoftBounce", "BadEmailAddress", "DnsError", "Blocked", "ManuallyDeactivated", "Unsubscribe", "DMARCPolicy", "Unknown", ""]) assert.equal(bounceKind(t), "bounce", t);
});
