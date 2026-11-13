import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AUTOMATIC_LABELS,
  CORRECTION_LABELS,
  POSITIVE_LABELS,
  attributeReplies,
  candidatesFor,
  conversationsOf,
  earliestByThread,
  inboxKey,
  normAddress,
  toAddresses,
  type Conversation,
  type MessageFacts,
  type ThreadFacts,
} from "./inbox-positives.ts";

/*
 * Replies and positive replies per inbox (14 Nov). What counts, and for which
 * inbox. The two ways this goes quietly wrong have the most cases:
 *   · a reply counted for the inbox the conversation shows NOW (Nicole's, after
 *     an introduction) instead of the one the lead replied to, and
 *   · a positive that is not one of the same inbox's replies.
 */

const thread = (id: string, over: Partial<ThreadFacts> = {}): ThreadFacts => ({
  id, status: "open", source_provider: "emailbison", outbound_sender_email: `cold-${id}@one.com`, ...over,
});
const reply = (thread_id: string, to: unknown, sent_at: string | null = "2026-11-01T10:00:00Z"): MessageFacts => ({ thread_id, recipients: { to, cc: [], bcc: [] }, sent_at });
const sent = (thread_id: string, sender: string | null, sent_at = "2026-10-30T10:00:00Z"): MessageFacts => ({ thread_id, sender, sent_at });

test("an address: bare or with a name, any case, trimmed; anything else is none", () => {
  assert.equal(normAddress("  Nicole@BrokerStaffer.com "), "nicole@brokerstaffer.com");
  assert.equal(normAddress("Nicole Collins <Nicole@BrokerStaffer.com>"), "nicole@brokerstaffer.com");
  assert.equal(normAddress("not an address"), null);
  assert.equal(normAddress(""), null);
  assert.equal(normAddress("a@b@c"), null);
  assert.equal(normAddress(null), null);
  assert.equal(normAddress(42), null);
});

test("a message's To: strings or objects, each once, in order; no To is none", () => {
  assert.deepEqual(toAddresses({ to: ["B@one.com", { address: "c@one.com" }, { email: "d@one.com" }, "b@one.com", "junk"] }), ["b@one.com", "c@one.com", "d@one.com"]);
  assert.deepEqual(toAddresses({ cc: ["a@one.com"] }), []);
  assert.deepEqual(toAddresses(null), []);
  assert.deepEqual(toAddresses({ to: "a@one.com" }), [], "To is a list in Master Inbox; a lone string is not trusted");
});

test("the earliest message of each conversation, whatever order they come in; an undated one is never first", () => {
  const first = earliestByThread([
    reply("t1", ["late@one.com"], "2026-11-02T00:00:00Z"),
    reply("t1", ["early@one.com"], "2026-11-01T00:00:00Z"),
    reply("t1", ["undated@one.com"], null),
    reply("t2", ["only@one.com"], "2026-11-05T00:00:00Z"),
  ]);
  assert.deepEqual(toAddresses(first.get("t1")!.recipients), ["early@one.com"]);
  assert.deepEqual(toAddresses(first.get("t2")!.recipients), ["only@one.com"]);
  assert.equal(earliestByThread([reply("t3", ["x@one.com"], null)]).has("t3"), false);
});

test("candidates: whom the first reply went to, then our first email's sender, then the conversation's inbox — each once", () => {
  const t = thread("t1", { outbound_sender_email: "Nicole@BrokerStaffer.com" });
  assert.deepEqual(
    candidatesFor(t, reply("t1", ["cold@one.com", "other@one.com"]), sent("t1", "cold@one.com")),
    ["cold@one.com", "other@one.com", "nicole@brokerstaffer.com"],
  );
  assert.deepEqual(candidatesFor(t, undefined, sent("t1", "first@one.com")), ["first@one.com", "nicole@brokerstaffer.com"]);
  assert.deepEqual(candidatesFor(t, undefined, undefined), ["nicole@brokerstaffer.com"]);
  assert.deepEqual(candidatesFor(thread("t2", { outbound_sender_email: null }), undefined, undefined), []);
});

const convs = (threads: ThreadFacts[], labels: Record<string, string | string[]>, positive: string[], replies: MessageFacts[] = [], sends: MessageFacts[] = []) =>
  conversationsOf(
    threads,
    new Map(Object.entries(labels).map(([k, v]) => [k, Array.isArray(v) ? v : [v]])),
    new Set(positive),
    earliestByThread(replies),
    earliestByThread(sends),
  );

test("every conversation is a reply — except one in Trash, and an out-of-office or automatic one", () => {
  const out = convs(
    [thread("a"), thread("b", { status: "trash" }), thread("c"), thread("d"), thread("e"), thread("f", { status: "archived" })],
    { a: "Not Interested", c: "OOO", d: "Automated Response", e: "OOO Sequence" },
    [],
  );
  assert.deepEqual(out.map((c) => c.threadId), ["a", "f"]);
  assert.ok(out.every((c) => !c.positive));
});

test("positive: ever marked Interested or introduced — after it moves on too — but not once corrected to a 'no'", () => {
  const ids = ["int", "intro", "noshow", "keepwarm", "ooo", ...CORRECTION_LABELS].map((x) => x.replace(/\W/g, ""));
  const labels: Record<string, string> = { int: "Interested", intro: "Introduction", noshow: "No Show / No Response", keepwarm: "Keep Warm", ooo: "OOO" };
  for (const l of CORRECTION_LABELS) labels[l.replace(/\W/g, "")] = l;
  const out = convs(ids.map((id) => thread(id)), labels, ids);
  const positive = Object.fromEntries(out.map((c) => [c.threadId, c.positive]));
  assert.deepEqual(positive, {
    int: true, intro: true, noshow: true, keepwarm: true,
    // An out-of-office after the team judged the lead positive is still that lead's positive reply.
    ooo: true,
    NotInterested: false, NotQualified: false, DoNotContact: false, Unsubscribe: false, BrokerOwner: false,
  });
  // A corrected one is still a reply.
  assert.equal(out.length, ids.length);
  // In Trash it is neither.
  assert.deepEqual(convs([thread("x", { status: "trash" })], { x: "Introduction" }, ["x"]), []);
});

test("never marked: not positive, whatever its label now", () => {
  const out = convs([thread("a"), thread("b")], { a: "Interested" }, []);
  // A label with no history row cannot happen while 0080's trigger runs; if it did, the history decides.
  assert.deepEqual(out.map((c) => c.positive), [false, false]);
});

test("introduced from Nicole's inbox: the reply is still the cold inbox's", () => {
  const out = convs(
    [thread("t1", { outbound_sender_email: "nicole@brokerstaffer.com" })],
    { t1: "Introduction" },
    ["t1"],
    [reply("t1", ["s.ray@marketbranddirect.co"], "2026-11-13T11:55:00Z"), reply("t1", ["nicole@brokerstaffer.com"], "2026-11-13T14:11:00Z")],
    [sent("t1", "S.Ray@marketbranddirect.co", "2026-11-11T19:20:00Z"), sent("t1", "nicole@brokerstaffer.com", "2026-11-13T14:11:00Z")],
  );
  assert.equal(out[0].candidates[0], "s.ray@marketbranddirect.co");
  const { byInbox } = attributeReplies(out, [
    { platform: "emailbison", email: "S.Ray@marketbranddirect.co" },
    { platform: "emailbison", email: "nicole@brokerstaffer.com" },
  ]);
  assert.deepEqual(byInbox.get(inboxKey("emailbison", "s.ray@marketbranddirect.co")), { replies: 1, positive: 1 });
  assert.equal(byInbox.get(inboxKey("emailbison", "nicole@brokerstaffer.com")), undefined);
});

test("a campaign sent from Nicole's inbox is Nicole's", () => {
  const out = convs([thread("t1", { outbound_sender_email: "nicole@brokerstaffer.com" })], {}, [], [reply("t1", ["nicole@brokerstaffer.com"])]);
  const { byInbox } = attributeReplies(out, [{ platform: "emailbison", email: "nicole@brokerstaffer.com" }]);
  assert.deepEqual(byInbox.get(inboxKey("emailbison", "nicole@brokerstaffer.com")), { replies: 1, positive: 0 });
});

const c = (threadId: string, candidates: string[], over: Partial<Conversation> = {}): Conversation => ({ threadId, platform: "emailbison", candidates, positive: false, ...over });

test("each reply counts once, for the first candidate that is an inbox; replies and positives add up", () => {
  const { byInbox, unattributed } = attributeReplies(
    [
      c("1", ["gone@one.com", "a@one.com"]),
      c("2", ["a@one.com"], { positive: true }),
      c("3", ["b@one.com", "a@one.com"]),
      c("4", ["nobody@one.com"], { positive: true }),
      c("5", []),
    ],
    [{ platform: "emailbison", email: "A@One.com" }, { platform: "emailbison", email: "b@one.com" }],
  );
  assert.deepEqual(byInbox.get("emailbison:a@one.com"), { replies: 2, positive: 1 });
  assert.deepEqual(byInbox.get("emailbison:b@one.com"), { replies: 1, positive: 0 });
  assert.deepEqual(unattributed, { replies: 2, positive: 1 });
  const total = [...byInbox.values()].reduce((n, t) => n + t.replies, 0) + unattributed.replies;
  assert.equal(total, 5, "nothing counted twice, nothing lost");
});

test("one mailbox on both platforms: it counts where the conversation came through, else where the inbox is", () => {
  const both = [{ platform: "emailbison" as const, email: "m@one.com" }, { platform: "instantly" as const, email: "m@one.com" }];
  const ebOnly = [{ platform: "emailbison" as const, email: "m@one.com" }];
  assert.deepEqual([...attributeReplies([c("1", ["m@one.com"], { platform: "instantly" })], both).byInbox.keys()], ["instantly:m@one.com"]);
  assert.deepEqual([...attributeReplies([c("1", ["m@one.com"], { platform: "emailbison" })], both).byInbox.keys()], ["emailbison:m@one.com"]);
  // Its own platform has no such inbox (the account was removed there): the other's.
  assert.deepEqual([...attributeReplies([c("1", ["m@one.com"], { platform: "instantly" })], ebOnly).byInbox.keys()], ["emailbison:m@one.com"]);
  // A conversation of no known platform goes to EmailBison's when both have it.
  assert.deepEqual([...attributeReplies([c("1", ["m@one.com"], { platform: null })], both).byInbox.keys()], ["emailbison:m@one.com"]);
});

test("a platform whose inboxes could not be read: its replies are set aside, never moved to the other platform", () => {
  const { byInbox, unlisted, unattributed } = attributeReplies(
    [c("1", ["m@one.com"], { platform: "instantly", positive: true }), c("2", ["m@one.com"], { platform: "emailbison" })],
    [{ platform: "emailbison", email: "m@one.com" }],
    ["instantly"],
  );
  assert.deepEqual(byInbox.get("emailbison:m@one.com"), { replies: 1, positive: 0 });
  assert.deepEqual(unlisted, { replies: 1, positive: 1 });
  assert.deepEqual(unattributed, { replies: 0, positive: 0 });
});

test("a positive is always one of the same inbox's replies", () => {
  const list = Array.from({ length: 200 }, (_, i) =>
    c(String(i), [`x${i % 7}@one.com`, `y${i % 3}@one.com`], { platform: i % 2 ? "instantly" : "emailbison", positive: i % 5 === 0 }),
  );
  const inboxes = [0, 1, 2, 3, 4, 5, 6].flatMap((i) => [{ platform: "emailbison" as const, email: `x${i}@one.com` }, { platform: "instantly" as const, email: `y${i % 3}@one.com` }]);
  for (const [key, t] of attributeReplies(list, inboxes).byInbox) assert.ok(t.positive <= t.replies, key);
});

test("the corrections are pay-per-lead billing's, word for word", () => {
  const source = readFileSync(new URL("../../clients/usage-billing/leads.ts", import.meta.url), "utf8");
  const m = /export const CORRECTION_LABELS[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(m, "billing still names its corrections");
  const billing = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual([...CORRECTION_LABELS].sort(), billing);
  assert.deepEqual([...POSITIVE_LABELS], ["Interested", "Introduction"]);
  assert.deepEqual([...AUTOMATIC_LABELS].sort(), ["Automated Response", "OOO", "OOO Sequence"]);
});

test("a conversation with more than one label: any 'no' label corrects it, and it is automatic only if every label is", () => {
  const out = convs(
    [thread("a"), thread("b"), thread("c"), thread("d")],
    { a: ["No Show / No Response", "Introduction"], b: ["Introduction", "Not Interested"], c: ["OOO", "Objection"], d: ["OOO", "Automated Response"] },
    ["a", "b"],
  );
  assert.deepEqual(out.map((x) => [x.threadId, x.positive]), [["a", true], ["b", false], ["c", false]]);
});

test("a conversation read twice (a page boundary) is one reply", () => {
  const out = convs([thread("a"), thread("a"), thread("b")], {}, ["a"]);
  assert.deepEqual(out.map((x) => x.threadId), ["a", "b"]);
});
