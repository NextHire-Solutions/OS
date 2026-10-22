import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { sendTest } from "./postmark.ts";
import {
  asTest, isTestRecipient, MAX_TEST_RECIPIENTS, parseTestRecipients, resetTestSends, sampleEmail, takeTestSend, TEST_DAILY_CAP, TEST_RECIPIENTS, testAddressRefusal,
} from "./test-send.ts";

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
  assert.match(body, /sendTest\(email, \{ env, fetch: deps\.testFetch, allowed: toList \}\)/, "the transport gets the list as checked now");
  assert.match(body, /const toList = ctx \? saved\.list\.filter\(\(a\) => testAddressRefusal\(a, ctx\) === null\) : saved\.list;/, "every saved address is checked again at send time");
  const route = readFileSync("src/app/api/tools/master-inbox/relay/test/route.ts", "utf8");
  assert.ok(route.indexOf("requireAdminSession()") < route.indexOf("sendRelayTest("), "admins first");
  assert.deepEqual([...route.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]), ["POST", "PUT"]);
  const put = route.slice(route.indexOf("export async function PUT"));
  assert.ok(put.indexOf("requireAdminSession()") > 0 && put.indexOf("requireAdminSession()") < put.indexOf("saveTestRecipients("), "PUT: admins first");
});

/* ---------------------------------------------- a test address set on the page (23 Oct) --- */

const CTX = {
  team: new Set(["eddy@brokerstaffer.com", "teammate@gmail.com"]),
  brokerage: new Set(["angela@jeffcook.test", "owner@brokerstaffer.com"]),
};

test("a test address: our own domains or Team access — never a brokerage contact, never anyone else", () => {
  for (const ok of ["admin@outreachify.io", "Automation@Outreachify.io", "eddy@brokerstaffer.com", "amy@brokerstaffer.com", "teammate@gmail.com"]) {
    assert.equal(testAddressRefusal(ok, CTX), null, ok);
  }
  const no: Array<[string, RegExp]> = [
    ["angela@jeffcook.test", /brokerage's contact list/],
    ["owner@brokerstaffer.com", /brokerage's contact list/], // even on our domain
    ["someone@gmail.com", /not one of ours/],
    ["agent@kw.com", /not one of ours/],
    ["x@leads.brokerstaffer.com", /not one of ours/], // a subdomain is not the domain
    ["x@brokerstaffer.com.evil.com", /not one of ours/],
    ["x@outreachify.io.evil.com", /not one of ours/],
    ["not an address", /not an email address/],
    ["a@b", /not an email address/],
  ];
  for (const [a, why] of no) assert.match(testAddressRefusal(a, CTX) ?? "", why, a);
});

test("the list typed on the page: commas, semicolons or spaces; lower-cased; no repeats; one to three; every one checked", () => {
  assert.deepEqual(parseTestRecipients(" Eddy@BrokerStaffer.com, admin@outreachify.io;eddy@brokerstaffer.com ", CTX), { list: ["eddy@brokerstaffer.com", "admin@outreachify.io"] });
  assert.deepEqual(parseTestRecipients(["admin@outreachify.io"], CTX), { list: ["admin@outreachify.io"] });
  assert.match((parseTestRecipients("", CTX) as { error: string }).error, /at least one/);
  assert.match((parseTestRecipients("a@outreachify.io b@outreachify.io c@outreachify.io d@outreachify.io", CTX) as { error: string }).error, new RegExp(`At most ${MAX_TEST_RECIPIENTS}`));
  assert.match((parseTestRecipients("admin@outreachify.io, angela@jeffcook.test", CTX) as { error: string }).error, /angela@jeffcook\.test is on a brokerage's contact list/, "one bad address refuses the whole save");
});

test("the transport takes the checked list — and still refuses anyone not on it, and two at once", async () => {
  const allowed = ["eddy@brokerstaffer.com", "admin@outreachify.io"];
  const toEddy = sampleEmail(FROM, "eddy@brokerstaffer.com");
  const ok = fakeFetch();
  assert.equal((await sendTest(toEddy, { env: TOKEN_ONLY, fetch: ok.f, allowed })).ok, true);
  assert.equal(ok.calls[0].body.To, "eddy@brokerstaffer.com");
  assert.equal(ok.calls[0].body.ReplyTo, "eddy@brokerstaffer.com", "a reply to the test comes back to the tester");
  // Without the list, only the fixed address.
  const none = fakeFetch();
  assert.equal((await sendTest(toEddy, { env: TOKEN_ONLY, fetch: none.f })).ok, false);
  assert.equal(none.calls.length, 0);
  for (const bad of [
    { ...toEddy, to: [{ name: null, email: "angela@brokerage.com" }], toHeader: "angela@brokerage.com", replyTo: "angela@brokerage.com" },
    { ...toEddy, to: [{ name: null, email: "eddy@brokerstaffer.com" }, { name: null, email: "admin@outreachify.io" }] },
  ]) {
    const x = fakeFetch();
    assert.equal((await sendTest(bad, { env: TOKEN_ONLY, fetch: x.f, allowed })).ok, false);
    assert.equal(x.calls.length, 0);
  }
});

test("portal sign-in emails keep the FIXED test address — a hand-off test address never widens them", () => {
  assert.deepEqual([...TEST_RECIPIENTS], ["admin@outreachify.io"]);
  const mail = readFileSync("src/lib/portal-login/mail.ts", "utf8");
  assert.match(mail, /import \{ isTestRecipient \} from "@\/lib\/tools\/master-inbox\/relay\/test-send";/);
  assert.doesNotMatch(mail, /test_recipients|loadTestRecipients|parseTestRecipients/);
  const src = readFileSync("src/lib/tools/master-inbox/relay/test-send.ts", "utf8");
  const fn = src.slice(src.indexOf("export function isTestRecipient("), src.indexOf("\n}\n", src.indexOf("export function isTestRecipient(")));
  assert.match(fn, /TEST_RECIPIENTS\.includes\(a\)/);
});
