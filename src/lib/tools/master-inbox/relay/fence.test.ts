import { test } from "node:test";
import assert from "node:assert/strict";

import { liveOnlyDomains, withinLiveFence } from "./gate.ts";
import { createPostmarkTransport } from "./postmark.ts";
import type { RelayEmail } from "./message.ts";

/*
 * The pilot fence (24 Oct): while OS_BROKERAGE_RELAY_LIVE_ONLY is set, a live
 * hand-off may go only to its domains — checked by the relay, and again by the
 * Postmark transport before any request exists.
 */

const FENCE = { OS_BROKERAGE_RELAY_LIVE_ONLY: "brokerstaffer.com" };

test("the fence's domains: exact, case aside, an @ allowed; nonsense names none (which fences everything); unset is no fence", () => {
  assert.deepEqual(liveOnlyDomains({ OS_BROKERAGE_RELAY_LIVE_ONLY: " BrokerStaffer.com , @outreachify.io" }), ["brokerstaffer.com", "outreachify.io"]);
  assert.deepEqual(liveOnlyDomains({ OS_BROKERAGE_RELAY_LIVE_ONLY: "" }), []);
  assert.deepEqual(liveOnlyDomains({ OS_BROKERAGE_RELAY_LIVE_ONLY: "*, brokerstaffer, http://x.com" }), []);
  assert.equal(liveOnlyDomains({}), null);
});

test("within the fence: every address on an allowed domain — no subdomain, no look-alike, no empty list", () => {
  assert.equal(withinLiveFence(["ryan.j@brokerstaffer.com", "Eddy@BrokerStaffer.com"], FENCE), true);
  for (const bad of [["ryan@brokerstaffer.com", "lance@jeffcook.test"], ["x@mail.brokerstaffer.com"], ["x@brokerstaffer.com.evil.test"], ["x@notbrokerstaffer.com"], ["brokerstaffer.com"], ["a@b@brokerstaffer.com"], []]) {
    assert.equal(withinLiveFence(bad, FENCE), false, JSON.stringify(bad));
  }
  assert.equal(withinLiveFence([], { OS_BROKERAGE_RELAY_LIVE_ONLY: "" }), false);
  assert.equal(withinLiveFence(["lance@jeffcook.test"], {}), true, "no fence: the other locks decide");
});

const email = (to: string[]): RelayEmail => ({
  from: '"Jordan Ellis via BrokerStaffer" <agents@leads.brokerstaffer.com>', fromName: "Jordan Ellis via BrokerStaffer", fromAddress: "agents@leads.brokerstaffer.com",
  to: to.map((e) => ({ name: null, email: e })), toHeader: to.join(", "), replyTo: "jordan@coastal.test", subject: "Re: Hi", textBody: "Sure", htmlBody: "<p>Sure</p>",
  headers: [], metadata: { relay_id: "r1", thread_id: "t1" },
} as unknown as RelayEmail);

test("the Postmark transport refuses anything outside the fence before a request exists — and sends what is inside", async () => {
  const calls: string[] = [];
  const fetch = (async (url: string) => { calls.push(String(url)); return new Response(JSON.stringify({ ErrorCode: 0, MessageID: "pm-9", SubmittedAt: "now" }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
  const env = { OS_BROKERAGE_RELAY_LIVE_SEND: "1", POSTMARK_SERVER_TOKEN: "t", ...FENCE };
  const t = createPostmarkTransport({ fetch, env });
  const out = await t.send(email(["ryan.j@brokerstaffer.com", "lance@jeffcook.test"]));
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.gated, "outside_fence");
  assert.equal(out.ok === false && out.definite, true);
  assert.equal(calls.length, 0, "no request was built");
  const ok = await t.send(email(["ryan.j@brokerstaffer.com", "eddy@brokerstaffer.com"]));
  assert.equal(ok.ok, true);
  assert.equal(calls.length, 1);
});
