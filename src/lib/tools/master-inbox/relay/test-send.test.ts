import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { sendTest } from "./postmark.ts";
import { asTest, isTestRecipient, resetTestSends, sampleEmail, takeTestSend, TEST_DAILY_CAP, TEST_RECIPIENTS } from "./test-send.ts";

/*
 * Test sends (user, 20 Oct): "test this properly with our own email address
 * like admin@outreachify.io. no testing with clients" — and "do not make this
 * live". A test reaches our own address and nobody else, and needs no live switch.
 */

const FROM = "agents@leads.brokerstaffer.com";
const TOKEN_ONLY = { POSTMARK_SERVER_TOKEN: "pm-test-token" }; // OS_BROKERAGE_RELAY_LIVE_SEND deliberately unset

function fakeFetch() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ErrorCode: 0, MessageID: "pm-msg-1", SubmittedAt: "2026-10-20T10:00:00Z" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("only admin@outreachify.io — the user's own address — is a test recipient", () => {
  assert.deepEqual([...TEST_RECIPIENTS], ["admin@outreachify.io"]);
  assert.equal(isTestRecipient(" Admin@Outreachify.io "), true);
  for (const a of ["eddy@brokerstaffer.com", "amy@brokerstaffer.com", "admin@outreachify.io.evil.com", "xadmin@outreachify.io", "angela@kw.com", "", null]) {
    assert.equal(isTestRecipient(a), false, String(a));
  }
});

test("a sample: made-up words, to the test address only, Reply-To the test address, no threading, marked TEST", () => {
  const e = sampleEmail(FROM, "admin@outreachify.io");
  assert.deepEqual(e.to, [{ name: null, email: "admin@outreachify.io" }]);
  assert.equal(e.toHeader, "admin@outreachify.io");
  assert.equal(e.replyTo, "admin@outreachify.io");
  assert.deepEqual(e.headers, []);
  assert.match(e.subject, /^\[TEST\] /);
  assert.match(e.textBody, /^TEST — sent only to admin@outreachify\.io/);
  assert.match(e.htmlBody, /TEST — sent only to admin@outreachify\.io/);
  assert.match(e.textBody, /Sam Sample|thanks for reaching out/);
  assert.equal(e.fromAddress, FROM);
});

test("a copy of a real hand-off: the brokerage and the agent are NAMED in the banner, never addressed", () => {
  const e = asTest(
    { fromName: "Jane Agent via BrokerStaffer", fromAddress: FROM, from: `"Jane Agent via BrokerStaffer" <${FROM}>`, subject: "Re: Your next move", textBody: "Yes, interested.", htmlBody: "<div>Yes, interested.</div>" },
    "admin@outreachify.io",
    { intended: [{ name: "Angela", email: "angela@brokerage.com" }], agentReplyTo: "Jane Agent <jane@agent.com>", source: "A copy of a prepared hand-off." },
  );
  assert.deepEqual(e.to.map((x) => x.email), ["admin@outreachify.io"]);
  assert.equal(e.replyTo, "admin@outreachify.io", "answering the test cannot reach the agent");
  assert.deepEqual(e.headers, [], "no In-Reply-To into the agent's thread");
  assert.match(e.textBody, /In live use this goes to: Angela <angela@brokerage\.com>\./);
  assert.match(e.textBody, /replies go to the agent: Jane Agent <jane@agent\.com>/);
  assert.equal(e.subject, "[TEST] Re: Your next move");
  assert.equal(asTest({ ...e, subject: e.subject }, "admin@outreachify.io", { intended: [], agentReplyTo: null, source: "" }).subject, "[TEST] Re: Your next move", "never [TEST] [TEST]");
});

test("the transport sends a test WITHOUT the live switch — and only to the test address, with Postmark's test tag and no headers", async () => {
  const { f, calls } = fakeFetch();
  const r = await sendTest(sampleEmail(FROM, "admin@outreachify.io"), { env: TOKEN_ONLY, fetch: f });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.To, "admin@outreachify.io");
  assert.equal(calls[0].body.ReplyTo, "admin@outreachify.io");
  assert.equal(calls[0].body.Tag, "brokerage-relay-test");
  assert.deepEqual(calls[0].body.Headers, []);
  assert.equal(calls[0].body.MessageStream, "outbound");
});

test("the transport refuses — before any request — a test to anyone else, two recipients, an agent's Reply-To, a hidden To, a bad From, no token", async () => {
  const good = sampleEmail(FROM, "admin@outreachify.io");
  const cases = [
    { ...good, to: [{ name: null, email: "angela@brokerage.com" }], toHeader: "angela@brokerage.com" },
    { ...good, to: [{ name: null, email: "admin@outreachify.io" }, { name: null, email: "angela@brokerage.com" }] },
    { ...good, replyTo: "Jane <jane@agent.com>" },
    // 21 Oct review: a list or a name around the test address is not the test address.
    { ...good, replyTo: '"victim@x.com, <admin@outreachify.io>' },
    { ...good, replyTo: "victim@x.com, admin@outreachify.io" },
    { ...good, replyTo: "Someone <admin@outreachify.io>, victim@x.com" },
    { ...good, toHeader: "admin@outreachify.io, angela@brokerage.com" },
    { ...good, fromAddress: "eddy@brokerstaffer.com" },
  ];
  for (const c of cases) {
    const { f, calls } = fakeFetch();
    const r = await sendTest(c, { env: TOKEN_ONLY, fetch: f });
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0, "nothing reached Postmark");
  }
  const { f, calls } = fakeFetch();
  assert.equal((await sendTest(good, { env: {}, fetch: f })).ok, false);
  assert.equal(calls.length, 0);
});

test("From is built from the checked address — a caller's From header never reaches Postmark (21 Oct review)", async () => {
  const good = sampleEmail(FROM, "admin@outreachify.io");
  const { f, calls } = fakeFetch();
  const r = await sendTest({ ...good, from: '"Eddy" <eddy@brokerstaffer.com>' }, { env: TOKEN_ONLY, fetch: f });
  assert.equal(r.ok, true);
  assert.equal(calls[0].body.From, `"Sam Sample via BrokerStaffer" <${FROM}>`);
  assert.equal(calls[0].body.ReplyTo, "admin@outreachify.io");
});

test("at most TEST_DAILY_CAP test sends a day", () => {
  resetTestSends();
  const t = Date.UTC(2026, 9, 20, 12);
  for (let i = 0; i < TEST_DAILY_CAP; i++) assert.equal(takeTestSend(t), true);
  assert.equal(takeTestSend(t + 1), false);
  assert.equal(takeTestSend(t + 24 * 3_600_000), true, "the next day");
  resetTestSends();
});

test("sendRelayTest changes no hand-off, takes no slot, counts no cap, and never asks for the live switch; the route is admins only", () => {
  const src = readFileSync("src/lib/tools/master-inbox/relay/relay.ts", "utf8");
  const start = src.indexOf("export async function sendRelayTest(");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.ok(start > 0);
  for (const w of [".update(", ".insert(", ".upsert(", ".delete(", "liveSendAllowed(", "os_brokerage_relay_agents", "transport.send("]) {
    assert.ok(!body.includes(w), `sendRelayTest must not use ${w}`);
  }
  assert.match(body, /sendTest\(email, \{ env, fetch: deps\.testFetch \}\)/);
  assert.match(body, /const to = TEST_RECIPIENTS\[0\];/);
  const route = readFileSync("src/app/api/tools/master-inbox/relay/test/route.ts", "utf8");
  assert.ok(route.indexOf("requireAdminSession()") < route.indexOf("sendRelayTest("), "admins first");
  assert.deepEqual([...route.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]), ["POST"]);
});
