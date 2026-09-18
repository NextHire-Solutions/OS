import assert from "node:assert/strict";
import { test } from "node:test";
import {
  comparable,
  cosine,
  dedupe,
  normaliseBody,
  pairTurns,
  qualityScore,
  rejectExample,
  selectExamples,
  similarity,
  verdictFor,
} from "./corpus-pure.ts";

/* ------------------------------------------------------------------ text */

test("entity-encoded and plain text are the same sentence", () => {
  // The finding that made this necessary: replies are stored HTML-encoded, so
  // without decoding, every send looked like a human edit.
  const stored = "Thank you for your response, Maria.I understand that you&#039;re currently in a brokerage";
  const typed = "Thank you for your response, Maria.I understand that you're currently in a brokerage";
  assert.equal(comparable(stored), comparable(typed));
  assert.equal(verdictFor(stored, typed).verdict, "as_written");
});

test("quoted history and sign-offs are dropped", () => {
  const body = [
    "Happy to help — shall we talk Thursday?",
    "",
    "On Mon, 2 Sep 2026 at 10:04, Jane Doe wrote:",
    "> the entire previous email",
    "> more quoted text",
  ].join("\n");
  const out = normaliseBody(body);
  assert.equal(out, "Happy to help — shall we talk Thursday?");
  assert.equal(out.includes("quoted"), false);
});

test("HTML is read when no plain text was stored", () => {
  assert.equal(normaliseBody(null, "<p>Hi Sam</p><p>Thursday works.</p>"), "Hi Sam\n\nThursday works.");
});

test("similarity separates a rewrite from a tweak", () => {
  const draft = "Great to hear you're interested, Karen. I've copied our team leader to arrange a time.";
  const tweak = "Great to hear you're interested, Karen. I've copied our team lead to arrange a time.";
  const rewrite = "Hey Karen, thanks — what does your current pipeline look like, and when did you last review your split?";
  assert.equal(verdictFor(draft, tweak).verdict, "light_edit");
  assert.equal(verdictFor(draft, rewrite).verdict, "rewritten");
  assert.ok(similarity(draft, tweak) > similarity(draft, rewrite));
});

test("a short draft inside a long reply is not 'as written'", () => {
  const draft = "Thanks, I'll follow up.";
  const sent = "Thanks, I'll follow up. " + "We work with 40 teams across the state and typically place two agents a month, ".repeat(6);
  assert.notEqual(verdictFor(draft, sent).verdict, "as_written");
});

/* --------------------------------------------------------------- pairing */

test("an inbound is paired with the reply that followed it", () => {
  const pairs = pairTurns([
    { id: "m1", direction: "outbound", bodyText: "our opener", bodyHtml: null, sentAt: "2026-09-01" },
    { id: "m2", direction: "inbound", bodyText: "who is this?", bodyHtml: null, sentAt: "2026-09-02" },
    { id: "m3", direction: "outbound", bodyText: "We recruit agents for brokerages in your area.", bodyHtml: null, sentAt: "2026-09-02" },
  ]);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].inboundMessageId, pairs[0].outboundMessageId], ["m2", "m3"]);
  assert.equal(pairs[0].inboundText, "who is this?");
});

test("our own opener teaches nothing — there is no question to answer", () => {
  assert.deepEqual(pairTurns([{ id: "m1", direction: "outbound", bodyText: "cold opener", bodyHtml: null, sentAt: null }]), []);
});

test("a lead who writes three times before we answer is one situation", () => {
  const pairs = pairTurns([
    { id: "a", direction: "inbound", bodyText: "hello?", bodyHtml: null, sentAt: null },
    { id: "b", direction: "inbound", bodyText: "still there?", bodyHtml: null, sentAt: null },
    { id: "c", direction: "inbound", bodyText: "what is this about exactly", bodyHtml: null, sentAt: null },
    { id: "d", direction: "outbound", bodyText: "Sorry for the delay — here is what we do.", bodyHtml: null, sentAt: null },
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].inboundMessageId, "c", "the message we actually answered");
});

/* ------------------------------------------------------------- filtering */

const ok = {
  inboundMessageId: "i", outboundMessageId: "o", sentAt: "2026-09-01",
  inboundText: "I'm already at a brokerage and happy where I am.",
  replyText: "Completely understand, Sam. Most of the agents we place were happy too — they moved for the Zillow access rather than away from anything. Worth ten minutes to compare?",
  label: "Objection",
};

test("a usable objection reply is kept", () => {
  assert.equal(rejectExample(ok), null);
});

test("automated mail, stubs and essays are dropped", () => {
  assert.equal(rejectExample({ ...ok, replyText: "Thanks!" }), "reply-too-short");
  assert.equal(rejectExample({ ...ok, replyText: "x".repeat(4001) }), "reply-too-long");
  assert.equal(rejectExample({ ...ok, inboundText: "ok" }), "inbound-too-short");
  assert.equal(rejectExample({ ...ok, inboundText: "Out of office until Monday, I will reply then." }), "automated");
});

test("the introduction macro is excluded — it has a button of its own", () => {
  // Left in, it floods retrieval and teaches the agent to improvise
  // introductions, which is the observed failure: it invented a contact.
  assert.equal(
    rejectExample({ ...ok, replyText: "Hey Karen, I'd like to introduce you to Mike Sposato, Broker and Owner at Carolina Realty Advisors." }),
    "intro-macro",
  );
});

test("unsubscribes and blocklist threads teach nothing", () => {
  assert.equal(rejectExample({ ...ok, label: "Unsubscribe" }), "useless-label");
  assert.equal(rejectExample({ ...ok, label: "Do Not Contact" }), "useless-label");
  assert.equal(rejectExample({ ...ok, label: "Objection" }), null);
});

/* --------------------------------------------------------------- quality */

test("a correction outranks plain history", () => {
  const base = { sentAt: "2026-09-01", label: "Objection", replyText: ok.replyText, now: new Date("2026-09-15") };
  const history = qualityScore({ ...base, source: "history" });
  const correction = qualityScore({ ...base, source: "correction" });
  assert.ok(correction > history, `${correction} should beat ${history}`);
});

test("recent beats old, and a thread that went somewhere beats one that did not", () => {
  const now = new Date("2026-09-15");
  const fresh = qualityScore({ sentAt: "2026-09-10", label: null, source: "history", replyText: ok.replyText, now });
  const stale = qualityScore({ sentAt: "2024-09-10", label: null, source: "history", replyText: ok.replyText, now });
  assert.ok(fresh > stale);
  const won = qualityScore({ sentAt: "2026-09-10", label: null, threadLabels: ["Interested"], source: "history", replyText: ok.replyText, now });
  assert.ok(won > fresh);
});

test("a score is always between 0 and 1", () => {
  const s = qualityScore({ sentAt: "2026-09-14", label: "Interested", threadLabels: ["Meetings Booked"], source: "correction", replyText: ok.replyText, now: new Date("2026-09-15") });
  assert.ok(s > 0 && s <= 1, String(s));
});

/* -------------------------------------------------------------- de-duping */

test("the same close sent a hundred times collapses to its best few", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    replyText: "Thanks for letting me know — I'll keep you posted on anything that fits.",
    quality: i / 100,
  }));
  rows.push({ replyText: "Completely different reply about Zillow Preferred and splits.", quality: 0.9 });
  const out = dedupe(rows, 3);
  assert.equal(out.length, 4, "three of the template plus the distinct one");
  assert.ok(out.filter((r) => r.replyText.startsWith("Thanks for letting")).every((r) => r.quality >= 0.97));
});

/* ------------------------------------------------------------- retrieval */

test("cosine behaves", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0, "a zero vector cannot be similar to anything");
});

test("retrieval prefers the good answer over the merely close one", () => {
  const chosen = selectExamples([1, 0, 0], [
    { embedding: [0.99, 0.1, 0], quality: 0.1, replyText: "a weak but very similar reply about splits" },
    { embedding: [0.9, 0.2, 0], quality: 1.0, replyText: "a strong reply about brokerage fit and Zillow access" },
  ], 2);
  assert.equal(chosen[0].quality, 1.0);
});

test("retrieval never returns the same reply twice", () => {
  const same = "Completely understand — most agents we place were happy where they were too.";
  const chosen = selectExamples([1, 0], [
    { embedding: [1, 0], quality: 0.9, replyText: same },
    { embedding: [0.99, 0.01], quality: 0.8, replyText: same + " Worth a look?" },
    { embedding: [0.5, 0.5], quality: 0.7, replyText: "Something else entirely about commission structure." },
  ], 3);
  assert.equal(chosen.length, 2, "the near-duplicate is skipped");
});

test("examples without an embedding are skipped, not crashed on", () => {
  const chosen = selectExamples([1, 0], [
    { embedding: null, quality: 1, replyText: "unembedded" },
    { embedding: [1, 0], quality: 0.5, replyText: "embedded" },
  ], 3);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].replyText, "embedded");
});

test("every phrasing of the introduction is excluded, not just one", () => {
  // The first dry run over the live mailbox let these through, and four of the
  // five best-scoring examples turned out to be introductions.
  for (const reply of [
    "Hey Susan, I'd like to introduce you to Michael Ramos, Founding Partner at Momentum Lux.",
    "Hey Susan, I'd like to introduce you directly to Michael Ramos, Founding Partner.",
    "Hey Kacee, I'm going to introduce you directly to Alma Nowatzke, Talent Acquisition Specialist.",
    "I would like to introduce you to our team leader so you can compare the splits properly.",
  ]) {
    assert.equal(rejectExample({ ...ok, replyText: reply }), "intro-macro", reply.slice(0, 50));
  }
});

test("a reply that merely mentions an introduction is still kept", () => {
  // "introduce" alone must not blacklist ordinary conversation.
  assert.equal(
    rejectExample({ ...ok, replyText: "Happy to walk you through how the introduction process works before you commit to anything at all." }),
    null,
  );
});
