/*
 * Our team's reply by email (4 Nov, Eddy: "Our reply should reach the client's email as well"). The switch is what keeps a
 * deploy from ever emailing a client on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CHAT_EMAIL_FROM, chatEmailOn, chatReplyMessage, chatReplyTo, mayEmailReply, sendChatReplyEmail } from "./mail.ts";

const MAIL = { to: "Jane@Acme.test", firstName: "Jane", from: "Amy", reply: "Import a CSV.\nThen tell us.", question: "How do I block an office?" };
const TEAM = { OS_PORTAL_CHAT_REPLY_TO: "Team@BrokerStaffer.test" };
const ON = { OS_PORTAL_CHAT_EMAIL: "1", POSTMARK_SERVER_TOKEN: "t", ...TEAM };
const OFF = { POSTMARK_SERVER_TOKEN: "t", ...TEAM };

function postmark(answer: { status?: number; body?: unknown } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer.body ?? { ErrorCode: 0 }), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, f };
}

test("switched off unless exactly 1: nothing reaches a client, only our own test address", async () => {
  for (const env of [{}, { OS_PORTAL_CHAT_EMAIL: "0" }, { OS_PORTAL_CHAT_EMAIL: "true" }, { OS_PORTAL_CHAT_EMAIL: "" }, { OS_CLIENT_SIGNIN: "1" }]) {
    assert.equal(mayEmailReply("jane@acme.test", { ...env, ...TEAM }), false, JSON.stringify(env));
    assert.equal(mayEmailReply("admin@outreachify.io", { ...env, ...TEAM }), true, "our own test address, to try it end to end");
  }
  assert.equal(mayEmailReply("jane@acme.test", { OS_PORTAL_CHAT_EMAIL: "1", ...TEAM }), true);
  assert.equal(mayEmailReply(" 1 ", { OS_PORTAL_CHAT_EMAIL: "1", ...TEAM }), false, "not an address");
  const { calls, f } = postmark();
  await assert.rejects(sendChatReplyEmail(MAIL, { fetch: f, env: OFF }), /switched off/);
  assert.equal(calls.length, 0, "refused before anything is sent");
});

test("the email: from BrokerStaffer, to that one person, with the reply; hitting Reply reaches a person", async () => {
  const { calls, f } = postmark();
  await sendChatReplyEmail(MAIL, { fetch: f, env: ON });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.postmarkapp.com/email");
  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(Object.keys(sent).sort(), ["From", "HtmlBody", "MessageStream", "ReplyTo", "Subject", "Tag", "TextBody", "To", "TrackLinks", "TrackOpens"], "no Cc, no Bcc, nothing else");
  assert.equal(sent.To, "jane@acme.test");
  assert.equal(sent.From, `"BrokerStaffer" <${CHAT_EMAIL_FROM}>`);
  assert.equal(sent.ReplyTo, "team@brokerstaffer.test", "the team inbox the user named");
  assert.equal(sent.Subject, "We replied to your question");
  assert.equal(sent.TrackOpens, false);
  assert.equal(sent.TrackLinks, "None");
  assert.equal(sent.Tag, "portal-chat-reply");
  assert.ok(sent.MessageStream);
  assert.equal(sent.TextBody, ['Hi Jane,', '', 'You asked: "How do I block an office?"', '', 'Import a CSV.\nThen tell us.', '', 'Amy, BrokerStaffer', '', "Reply to this email to answer us, or see the conversation in your portal's chat: https://os.brokerstaffer.com/portal-signin"].join("\n"));
  assert.match(sent.HtmlBody, /Import a CSV\.<br>Then tell us\./);
});

test("what someone typed is text in the email, never markup; no name or question is fine", () => {
  const m = chatReplyMessage({ to: "a@b.test", firstName: "<b>Jo</b>", from: "A&B", reply: '<script>alert(1)</script> "hi"', question: "<img src=x onerror=y>" });
  assert.doesNotMatch(m.html, /<script|<img|<b>Jo/);
  assert.match(m.html, /&lt;script&gt;/);
  assert.match(m.html, /A&amp;B, BrokerStaffer/);
  const plain = chatReplyMessage({ to: "a@b.test", firstName: null, from: null, reply: "Done.", question: null });
  assert.match(plain.text, /^Hi,\n\nDone\.\n\nBrokerStaffer\n/);
  assert.doesNotMatch(plain.html, /You asked/);
});

test("Postmark refusing, or no token: it says so, so our team is shown it didn't go", async () => {
  await assert.rejects(sendChatReplyEmail(MAIL, { fetch: postmark({ status: 422, body: { ErrorCode: 300 } }).f, env: ON }), /Postmark 422 \(code 300\)/);
  await assert.rejects(sendChatReplyEmail(MAIL, { fetch: postmark({ status: 200, body: { ErrorCode: 406 } }).f, env: ON }), /code 406/);
  await assert.rejects(sendChatReplyEmail(MAIL, { fetch: postmark().f, env: { OS_PORTAL_CHAT_EMAIL: "1", ...TEAM } }), /POSTMARK_SERVER_TOKEN/);
});

test("no team inbox for answers, or a retired one: nothing is sent at all, not even to our test address", async () => {
  for (const bad of [undefined, "", "not an address", "nicole.c@brokerstaffer.com", " Nicole.C@BrokerStaffer.com ", "support@leads.brokerstaffer.com"]) {
    const env = { OS_PORTAL_CHAT_EMAIL: "1", POSTMARK_SERVER_TOKEN: "t", ...(bad === undefined ? {} : { OS_PORTAL_CHAT_REPLY_TO: bad }) };
    assert.equal(chatReplyTo(env), null, String(bad));
    assert.equal(mayEmailReply("jane@acme.test", env), false, String(bad));
    assert.equal(mayEmailReply("admin@outreachify.io", env), false, `${bad}: not even our own test address`);
    const { calls, f } = postmark();
    await assert.rejects(sendChatReplyEmail(MAIL, { fetch: f, env }), /No team inbox for answers/, String(bad));
    assert.equal(calls.length, 0, String(bad));
  }
  assert.equal(chatReplyTo({ OS_PORTAL_CHAT_REPLY_TO: " Support@BrokerStaffer.com " }), "support@brokerstaffer.com");
});

test("what our team is told under the reply box: on only with the switch and a team inbox both", () => {
  assert.equal(chatEmailOn({ OS_PORTAL_CHAT_EMAIL: "1", ...TEAM }), true);
  for (const env of [{}, TEAM, { OS_PORTAL_CHAT_EMAIL: "1" }, { OS_PORTAL_CHAT_EMAIL: "1", OS_PORTAL_CHAT_REPLY_TO: "nicole.c@brokerstaffer.com" }, { OS_PORTAL_CHAT_EMAIL: "true", ...TEAM }]) {
    assert.equal(chatEmailOn(env), false, JSON.stringify(env));
  }
});

test("a reply that greets them already isn't greeted twice; one that doesn't is", () => {
  for (const reply of ["Hi Jane! Import a CSV.", "hello, import a CSV", "Hey — import a CSV", "Good morning Jane, import a CSV", "  Hi\nImport a CSV"]) {
    const m = chatReplyMessage({ ...MAIL, reply });
    assert.ok(m.text.startsWith('You asked: "How do I block an office?"'), reply);
    assert.doesNotMatch(m.html, /<p>Hi Jane,<\/p>/, reply);
  }
  for (const reply of ["Import a CSV.", "History first: import a CSV.", "Hiring season! Import a CSV.", "This is how: hi there"]) {
    const m = chatReplyMessage({ ...MAIL, reply });
    assert.ok(m.text.startsWith("Hi Jane,\n\n"), reply);
    assert.match(m.html, /<p>Hi Jane,<\/p>/, reply);
  }
});

test("the retired inbox in any spelling that still reaches it, or anything that isn't one plain address: never the team inbox", () => {
  for (const bad of ["nicole.c+team@brokerstaffer.com", "nicolec@brokerstaffer.com", "Nicole.C+x@BrokerStaffer.com", "nicole.c@brokerstaffer.com.", '"nicole.c"@brokerstaffer.com',
    "x,nicole.c@brokerstaffer.com", "team@brokerstaffer.com, nicole.c@brokerstaffer.com", "Team <team@brokerstaffer.com>", "a@b.leads.brokerstaffer.com", "team@brokerstaffer", "team@@brokerstaffer.com"]) {
    assert.equal(chatReplyTo({ OS_PORTAL_CHAT_REPLY_TO: bad }), null, bad);
    assert.equal(mayEmailReply("admin@outreachify.io", { OS_PORTAL_CHAT_EMAIL: "1", OS_PORTAL_CHAT_REPLY_TO: bad }), false, bad);
  }
  for (const good of ["support@brokerstaffer.com", "team+chat@brokerstaffer.com", "nicole.collins@brokerstaffer.com", "help@brokerstaffer.co.uk"]) {
    assert.equal(chatReplyTo({ OS_PORTAL_CHAT_REPLY_TO: good }), good, good);
  }
});
