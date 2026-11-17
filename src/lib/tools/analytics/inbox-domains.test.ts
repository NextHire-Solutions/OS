import { test } from "node:test";
import assert from "node:assert/strict";

import { bounceRate, DOMAIN_COLUMNS, domainOf, domainRows, domainSortValue, positiveRate, type DomainSource } from "./inbox-domains.ts";

/*
 * The Domains view (14 Nov): one row per sending domain, adding up its inboxes.
 * What must not happen: an unknown figure counted as 0, a mailbox on both
 * platforms counted as two inboxes, a rate that is not a share.
 */

const inbox = (email: string, over: Partial<DomainSource> = {}): DomainSource => ({
  email, sentAllTime: 100, bouncedAllTime: 1, masterInboxReplies: 10, positiveAllTime: 2, ...over,
});

test("a domain is what follows the @, lowercased", () => {
  assert.equal(domainOf("Nicole@RealtyTeamHQ.com"), "realtyteamhq.com");
  assert.equal(domainOf("odd@name@two.com"), "two.com");
  assert.equal(domainOf("no-at-sign"), null);
  assert.equal(domainOf("trailing@"), null);
});

test("positive rate: positives per reply, as a share; nothing to divide by is no rate", () => {
  assert.equal(positiveRate({ masterInboxReplies: 10, positiveAllTime: 3 }), 0.3);
  assert.equal(positiveRate({ masterInboxReplies: 10, positiveAllTime: 0 }), 0);
  assert.equal(positiveRate({ masterInboxReplies: 0, positiveAllTime: 0 }), null);
  assert.equal(positiveRate({ masterInboxReplies: null, positiveAllTime: 1 }), null);
  assert.equal(positiveRate({ masterInboxReplies: 4, positiveAllTime: null }), null);
  // Cannot happen with one source for both; if it ever did, no number beats a wrong one.
  assert.equal(positiveRate({ masterInboxReplies: 2, positiveAllTime: 3 }), null);
});

test("a domain adds up its inboxes; a mailbox on both platforms is one inbox", () => {
  const [d] = domainRows([
    inbox("a@one.com", { sentAllTime: 300, masterInboxReplies: 20, positiveAllTime: 5 }),
    inbox("A@One.com", { sentAllTime: 50, masterInboxReplies: 4, positiveAllTime: 1 }), // the same mailbox, on Instantly
    inbox("b@one.com", { sentAllTime: 10, masterInboxReplies: 0, positiveAllTime: 0 }),
  ]);
  assert.equal(d.domain, "one.com");
  assert.equal(d.inboxes, 2);
  assert.equal(d.sentAllTime, 360);
  assert.equal(d.masterInboxReplies, 24);
  assert.equal(d.positiveAllTime, 6);
  assert.deepEqual(d.missing, { sent: 0, replies: 0, positive: 0, bounce: 0 });
  assert.equal(positiveRate(d), 0.25);
});

test("an unknown figure is left out of a sum and counted as missing; all unknown is unknown, never 0", () => {
  const [d] = domainRows([
    inbox("a@one.com", { sentAllTime: null, masterInboxReplies: null, positiveAllTime: null }),
    inbox("b@one.com", { sentAllTime: 40 }),
  ]);
  assert.equal(d.sentAllTime, 40);
  assert.deepEqual(d.missing, { sent: 1, replies: 1, positive: 1, bounce: 1 });
  const [blank] = domainRows([inbox("a@two.com", { sentAllTime: null, bouncedAllTime: null, masterInboxReplies: null, positiveAllTime: null })]);
  assert.equal(blank.sentAllTime, null);
  assert.equal(blank.masterInboxReplies, null);
  assert.equal(blank.positiveAllTime, null);
  assert.equal(positiveRate(blank), null);
  assert.equal(bounceRate(blank), null);
});

test("bounce rate: bounced per sent, as a share; nothing sent, or a figure missing, is no rate", () => {
  assert.equal(bounceRate({ bounceSent: 200, bounceBounced: 5 }), 0.025);
  assert.equal(bounceRate({ bounceSent: 200, bounceBounced: 0 }), 0);
  assert.equal(bounceRate({ bounceSent: 0, bounceBounced: 0 }), null);
  assert.equal(bounceRate({ bounceSent: null, bounceBounced: 3 }), null);
  assert.equal(bounceRate({ bounceSent: 100, bounceBounced: null }), null);
  // More bounces than sends is not a share; no number beats a wrong one.
  assert.equal(bounceRate({ bounceSent: 2, bounceBounced: 3 }), null);
});

test("a domain's bounce rate adds up its inboxes' sent and bounced, a mailbox on both platforms included", () => {
  const [d] = domainRows([
    inbox("a@one.com", { sentAllTime: 300, bouncedAllTime: 6 }),
    inbox("A@One.com", { sentAllTime: 100, bouncedAllTime: 2 }), // the same mailbox, on Instantly
    inbox("b@one.com", { sentAllTime: 100, bouncedAllTime: 2 }),
  ]);
  assert.equal(d.bounceSent, 500);
  assert.equal(d.bounceBounced, 10);
  assert.equal(bounceRate(d), 0.02);
  assert.equal(d.missing.bounce, 0);
});

test("an inbox with sends but no bounce figure is left out of BOTH halves — not counted as never bouncing", () => {
  const [d] = domainRows([
    inbox("a@one.com", { sentAllTime: 100, bouncedAllTime: 4 }),
    inbox("b@one.com", { sentAllTime: 900, bouncedAllTime: null }),
    inbox("c@one.com", { sentAllTime: null, bouncedAllTime: 7 }),
  ]);
  // 4 of 100, not 4 of 1,000 or 11 of 100.
  assert.equal(bounceRate(d), 0.04);
  assert.equal(d.missing.bounce, 2);
  // Sent (all time) still adds every inbox that reports a send.
  assert.equal(d.sentAllTime, 1000);
});

test("Bounce rate is a Domains column, after Positive rate", () => {
  const keys = DOMAIN_COLUMNS.map((c) => c.key);
  assert.deepEqual(keys, ["inboxes", "sent", "miReplies", "positive", "positiveRate", "bounceRate"]);
});

test("one row per domain, A to Z; an address with no domain is in none", () => {
  const rows = domainRows([inbox("x@zeta.com"), inbox("y@Alpha.com"), inbox("z@alpha.com"), inbox("broken")]);
  assert.deepEqual(rows.map((r) => [r.domain, r.inboxes]), [["alpha.com", 2], ["zeta.com", 1]]);
  assert.deepEqual(domainRows([]), []);
});

test("every Domains column sorts by its own figure; unknown sorts as null", () => {
  const [d] = domainRows([inbox("a@one.com", { sentAllTime: 8, bouncedAllTime: 1, masterInboxReplies: 8, positiveAllTime: 2 })]);
  const want: Record<string, number | string | null> = { domain: "one.com", inboxes: 1, sent: 8, miReplies: 8, positive: 2, positiveRate: 0.25, bounceRate: 0.125 };
  for (const key of ["domain", ...DOMAIN_COLUMNS.map((col) => col.key)]) assert.equal(domainSortValue(d, key), want[key], key);
  const [blank] = domainRows([inbox("a@two.com", { sentAllTime: null, bouncedAllTime: null, masterInboxReplies: null, positiveAllTime: null })]);
  for (const key of ["sent", "miReplies", "positive", "positiveRate", "bounceRate"]) assert.equal(domainSortValue(blank, key), null, key);
  assert.equal(domainSortValue(d, "nonsense"), null);
});
