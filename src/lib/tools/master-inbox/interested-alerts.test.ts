/*
 * "A lead is Interested" → Slack, end to end against the fake database: what
 * is posted, that it is posted once, and every case that must post nothing.
 * Slack itself is the fake below — no test reaches slack.com.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "./test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
process.env.MASTER_INBOX_SLACK_BOT_TOKEN = "xoxb-test";
process.env.MASTER_INBOX_SLACK_CHANNEL_INTERESTED = "C-INTERESTED";

const db = new FakePostgrest();
/** What "Slack" answers next; ok unless a test says otherwise. */
let slackAnswer: { ok: boolean; error?: string } = { ok: true };
const slackPosts: Array<{ channel: string; text: string; unfurl_links: boolean; auth: string | null }> = [];
let outboxRefuses = false;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.host === "slack.com") {
    const body = JSON.parse(String(init?.body));
    slackPosts.push({ ...body, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(slackAnswer), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (outboxRefuses && url.pathname.endsWith("/side_effect_outbox") && (init?.method ?? "GET").toUpperCase() === "POST") {
    // What the real table says before migration 0033.
    return new Response(
      JSON.stringify({ code: "23514", message: 'new row for relation "side_effect_outbox" violates check constraint "side_effect_outbox_kind_check"', details: null, hint: null }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  return db.fetch(input, init);
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { sweepInterestedAlerts, deliverInterestedAlert } = await import("./interested-alerts.ts");
const { drain } = await import("./outbox.ts");

const WS = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-15T15:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function seed() {
  db.reset();
  slackPosts.length = 0;
  slackAnswer = { ok: true };
  outboxRefuses = false;
  db.seed("workspaces", [{ id: WS }]);
  const [interested, notInterested, objection] = db.seed("labels", [
    { workspace_id: WS, name: "Interested" },
    { workspace_id: WS, name: "Not Interested" },
    { workspace_id: WS, name: "Objection" },
  ]);
  const [wagner, demo] = db.seed("clients", [{ name: "Wagner Realty" }, { name: "Demo Portal" }]);
  const [jane, sam] = db.seed("leads", [
    { full_name: "Jane Agent", email: "jane@kw.test", company: "Keller Williams", custom_fields: { phone: "305-555-0100" } },
    { full_name: "Sam Demo", email: "sam@demo.test", company: "Demo Co", custom_fields: {} },
  ]);
  const [t1, t2] = db.seed("threads", [
    { workspace_id: WS, client_id: wagner.id, lead_id: jane.id, campaign_name: "Wagner – Miami agents" },
    { workspace_id: WS, client_id: demo.id, lead_id: sam.id, campaign_name: "Demo campaign" },
  ]);
  db.seed("messages", [
    { thread_id: t1.id, direction: "outbound", body_text: "Hi Jane, open to a chat about Wagner?", sent_at: minutesAgo(60 * 24) },
    { thread_id: t1.id, direction: "inbound", body_text: "Yes, I'd love to hear more.\n\nOn Mon, Oct 13, 2026 Nicole wrote:\n> Hi Jane", sent_at: minutesAgo(3) },
  ]);
  db.seed("side_effect_outbox", []);
  return { interested, notInterested, objection, wagner, demo, t1, t2 };
}

function assign(labelId: string, threadId: string, at: string) {
  const rows = db.rows("label_assignments");
  db.seed("label_assignments", [...rows, { workspace_id: WS, label_id: labelId, target_type: "thread", target_id: threadId, assigned_at: at }]);
}

test("a conversation newly labelled Interested is posted to the channel, with what the team needs", async () => {
  const { interested, t1 } = seed();
  assign(interested.id, t1.id, minutesAgo(2));

  const r = await sweepInterestedAlerts(NOW, { ws: WS });
  assert.equal(r.posted, 1, JSON.stringify(r));
  assert.equal(slackPosts.length, 1);
  const post = slackPosts[0];
  assert.equal(post.channel, "C-INTERESTED");
  assert.equal(post.auth, "Bearer xoxb-test");
  assert.equal(post.unfurl_links, false);
  assert.match(post.text, /\*Interested\* · Wagner Realty/);
  assert.match(post.text, /Jane Agent/);
  assert.match(post.text, /jane@kw\.test/);
  assert.match(post.text, /305/);
  assert.match(post.text, /Brokerage: Keller Williams/);
  assert.match(post.text, /Campaign: Wagner – Miami agents/);
  // Their reply, without the quoted email under it.
  assert.match(post.text, /> Yes, I'd love to hear more\./);
  assert.doesNotMatch(post.text, /Nicole wrote/);
  assert.match(post.text, new RegExp(`/inbox/all-email/${t1.id}\\|Open the conversation>`));

  const [row] = db.rows("side_effect_outbox");
  assert.equal(row.kind, "slack_interested");
  assert.equal(row.subject_id, t1.id);
  assert.equal(row.status, "done");
});

test("once per conversation: the next sweep, a re-label, and a second label pass post nothing", async () => {
  const { interested, t1 } = seed();
  assign(interested.id, t1.id, minutesAgo(2));
  await sweepInterestedAlerts(NOW, { ws: WS });
  assert.equal(slackPosts.length, 1);

  // The same window again — what the next minute's sweep sees.
  const again = await sweepInterestedAlerts(new Date(NOW.getTime() + 60_000), { ws: WS });
  assert.equal(again.claimed, 0);
  // Removed and put back (a new assignment row, newer timestamp).
  assign(interested.id, t1.id, minutesAgo(0));
  const relabel = await sweepInterestedAlerts(new Date(NOW.getTime() + 120_000), { ws: WS });
  assert.equal(relabel.claimed, 0);
  assert.equal(slackPosts.length, 1);
  assert.equal(db.rows("side_effect_outbox").length, 1);
});

test("Demo Portal conversations are never posted", async () => {
  const { interested, t2 } = seed();
  assign(interested.id, t2.id, minutesAgo(1));
  const r = await sweepInterestedAlerts(NOW, { ws: WS });
  assert.equal(r.skipped, 1);
  assert.equal(slackPosts.length, 0);
  const [row] = db.rows("side_effect_outbox");
  assert.equal(row.status, "done");
  assert.equal(row.last_error, "excluded");
});

test("other labels — Not Interested, Objection — post nothing", async () => {
  const { notInterested, objection, t1 } = seed();
  assign(notInterested.id, t1.id, minutesAgo(1));
  assign(objection.id, t1.id, minutesAgo(1));
  const r = await sweepInterestedAlerts(NOW, { ws: WS });
  assert.equal(r.seen, 0);
  assert.equal(slackPosts.length, 0);
  assert.equal(db.rows("side_effect_outbox").length, 0);
});

test("no backfill: labels from before go-live, or older than the sweep window, post nothing", async () => {
  const { interested, t1, t2 } = seed();
  assign(interested.id, t1.id, "2026-10-13T12:00:00.000Z"); // before go-live
  assign(interested.id, t2.id, minutesAgo(45)); // outside the 30-minute window
  const r = await sweepInterestedAlerts(NOW, { ws: WS });
  assert.equal(r.seen, 0);
  assert.equal(slackPosts.length, 0);

  // And just after go-live, a label from an hour before it is not swept up.
  db.seed("label_assignments", []);
  assign(interested.id, t1.id, "2026-10-14T01:00:00.000Z");
  const early = await sweepInterestedAlerts(new Date("2026-10-14T02:10:00.000Z"), { ws: WS });
  assert.equal(early.seen, 0);
  assert.equal(slackPosts.length, 0);
});

test("a label taken off before the alert goes out is not announced", async () => {
  const { interested, objection, t1 } = seed();
  const mustNotPost = async () => assert.fail("must not post");

  // Removed entirely.
  assert.equal(await deliverInterestedAlert(t1.id, { post: mustNotPost, channel: "C-INTERESTED" }), "no_longer_interested");
  // Changed to another label.
  assign(objection.id, t1.id, minutesAgo(1));
  assert.equal(await deliverInterestedAlert(t1.id, { post: mustNotPost, channel: "C-INTERESTED" }), "no_longer_interested");
  // Still on: posts.
  assign(interested.id, t1.id, minutesAgo(1));
  assert.equal(await deliverInterestedAlert(t1.id, { post: async () => ({ ok: true }), channel: "C-INTERESTED" }), "posted");
});

test("Slack refusing (bot not in the channel) leaves the alert pending with the reason, and the outbox drain retries it", async () => {
  const { interested, t1 } = seed();
  assign(interested.id, t1.id, minutesAgo(1));
  slackAnswer = { ok: false, error: "not_in_channel" };

  const r = await sweepInterestedAlerts(NOW, { ws: WS });
  assert.equal(r.failed, 1);
  assert.match(r.errors[0], /not_in_channel/);
  let [row] = db.rows("side_effect_outbox");
  assert.equal(row.status, "pending");
  assert.equal(row.claimed_at, null);
  assert.match(String(row.last_error), /not_in_channel/);

  // The bot is invited; the drain the OS already runs posts it, once.
  slackAnswer = { ok: true };
  const d = await drain();
  assert.equal(d.done, 1, JSON.stringify(d));
  [row] = db.rows("side_effect_outbox");
  assert.equal(row.status, "done");
  assert.equal(slackPosts.length, 2); // the refused try, then the real post
  assert.equal(slackPosts[1].channel, "C-INTERESTED");

  // Done means done: another drain does nothing.
  const d2 = await drain();
  assert.equal(d2.claimed, 0);
  assert.equal(slackPosts.length, 2);
});

test("before migration 0033 nothing is posted at all", async () => {
  const { interested, t1 } = seed();
  assign(interested.id, t1.id, minutesAgo(1));
  outboxRefuses = true;
  const r = await sweepInterestedAlerts(NOW, { ws: WS });
  assert.equal(r.off, "migration 0033 has not been run");
  assert.equal(r.posted, 0);
  assert.equal(slackPosts.length, 0);
});

test("switched off unless the channel and the bot token are both set", async () => {
  const { interested, t1 } = seed();
  assign(interested.id, t1.id, minutesAgo(1));
  delete process.env.MASTER_INBOX_SLACK_CHANNEL_INTERESTED;
  try {
    const r = await sweepInterestedAlerts(NOW, { ws: WS });
    assert.match(String(r.off), /SLACK_CHANNEL_INTERESTED/);
  } finally {
    process.env.MASTER_INBOX_SLACK_CHANNEL_INTERESTED = "C-INTERESTED";
  }
  delete process.env.MASTER_INBOX_SLACK_BOT_TOKEN;
  try {
    const r = await sweepInterestedAlerts(NOW, { ws: WS });
    assert.match(String(r.off), /SLACK_BOT_TOKEN/);
  } finally {
    process.env.MASTER_INBOX_SLACK_BOT_TOKEN = "xoxb-test";
  }
  assert.equal(slackPosts.length, 0);
  assert.equal(db.rows("side_effect_outbox").length, 0);
  assert.deepEqual(db.blocked, []);
});
