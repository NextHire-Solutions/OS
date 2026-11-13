import { test } from "node:test";
import assert from "node:assert/strict";

import { DOMAIN_COLUMNS, domainOf, domainRows, domainSortValue, positiveRate, type DomainSource } from "./inbox-domains.ts";

/*
 * The Domains view (14 Nov): one row per sending domain, adding up its inboxes.
 * What must not happen: an unknown figure counted as 0, a mailbox on both
 * platforms counted as two inboxes, a rate that is not a share.
 */

const inbox = (email: string, over: Partial<DomainSource> = {}): DomainSource => ({
  email, sentAllTime: 100, masterInboxReplies: 10, positiveAllTime: 2, ...over,
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
  assert.deepEqual(d.missing, { sent: 0, replies: 0, positive: 0 });
  assert.equal(positiveRate(d), 0.25);
});

test("an unknown figure is left out of a sum and counted as missing; all unknown is unknown, never 0", () => {
  const [d] = domainRows([
    inbox("a@one.com", { sentAllTime: null, masterInboxReplies: null, positiveAllTime: null }),
    inbox("b@one.com", { sentAllTime: 40 }),
  ]);
  assert.equal(d.sentAllTime, 40);
  assert.deepEqual(d.missing, { sent: 1, replies: 1, positive: 1 });
  const [blank] = domainRows([inbox("a@two.com", { sentAllTime: null, masterInboxReplies: null, positiveAllTime: null })]);
  assert.equal(blank.sentAllTime, null);
  assert.equal(blank.masterInboxReplies, null);
  assert.equal(blank.positiveAllTime, null);
  assert.equal(positiveRate(blank), null);
});

test("one row per domain, A to Z; an address with no domain is in none", () => {
  const rows = domainRows([inbox("x@zeta.com"), inbox("y@Alpha.com"), inbox("z@alpha.com"), inbox("broken")]);
  assert.deepEqual(rows.map((r) => [r.domain, r.inboxes]), [["alpha.com", 2], ["zeta.com", 1]]);
  assert.deepEqual(domainRows([]), []);
});

test("every Domains column sorts by its own figure; unknown sorts as null", () => {
  const [d] = domainRows([inbox("a@one.com", { sentAllTime: 7, masterInboxReplies: 8, positiveAllTime: 2 })]);
  const want: Record<string, number | string | null> = { domain: "one.com", inboxes: 1, sent: 7, miReplies: 8, positive: 2, positiveRate: 0.25 };
  for (const key of ["domain", ...DOMAIN_COLUMNS.map((col) => col.key)]) assert.equal(domainSortValue(d, key), want[key], key);
  const [blank] = domainRows([inbox("a@two.com", { sentAllTime: null, masterInboxReplies: null, positiveAllTime: null })]);
  for (const key of ["sent", "miReplies", "positive", "positiveRate"]) assert.equal(domainSortValue(blank, key), null, key);
  assert.equal(domainSortValue(d, "nonsense"), null);
});
