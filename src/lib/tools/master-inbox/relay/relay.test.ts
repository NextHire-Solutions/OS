/*
 * Interested replies → the brokerage, end to end against the in-memory
 * database (test/fake-postgrest.ts). Postmark is a fake transport that records
 * what it was handed; the fake database refuses any request to any other host
 * and lists it in `db.blocked`, which every test asserts is empty — so nothing
 * here can leave the process, and the tests prove what the relay does when it
 * is in practice (the default): it decides and records, and never calls the
 * transport.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest, type Row } from "../test/fake-postgrest.ts";
import type { RelayEmail } from "./message.ts";
import type { SendResult, Transport } from "./postmark.ts";
import type { Env } from "./gate.ts";

configureFakeEnvironment("MASTER_INBOX_");
for (const v of ["OS_BROKERAGE_RELAY_LIVE_SEND", "POSTMARK_SERVER_TOKEN", "OS_BROKERAGE_RELAY_FROM", "OS_BROKERAGE_RELAY"]) delete process.env[v];

const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const relay = await import("./relay.ts");

const WS = "00000000-0000-4000-8000-000000000001";
const GO_LIVE = "2026-10-15T00:00:00.000Z";
const NOW = new Date("2026-10-15T15:00:00.000Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const LIVE = { OS_BROKERAGE_RELAY_LIVE_SEND: "1" };

/* ------------------------------------------------------------ the fake Postmark */

const handed: RelayEmail[] = [];
let answer: SendResult = { ok: true, messageId: "pm-1", submittedAt: null };
const transport: Transport = {
  async send(email) {
    handed.push(email);
    return answer;
  },
};

/* ------------------------------------------------------------ the fake database */

function add(table: string, rows: Row[]): Array<Row & { id: string }> {
  const all = db.seed(table, [...db.rows(table), ...rows]);
  return all.slice(all.length - rows.length);
}

let L: Record<"interested" | "meetings" | "notInterested" | "introduction" | "unsubscribe", string>;
let P: Record<"jeff" | "wag" | "paused" | "demo" | "unknown", string>;
let C: Record<"jeff" | "wag" | "paused" | "demo", string>;

function seed(settings: Row = {}, jeffRelay: Row = {}) {
  db.reset();
  handed.length = 0;
  answer = { ok: true, messageId: "pm-1", submittedAt: null };
  db.seed("workspaces", [{ id: WS }]);
  const [interested, meetings, notInterested, introduction, unsubscribe] = db.seed("labels", [
    { workspace_id: WS, name: "Interested" },
    { workspace_id: WS, name: "Meetings Booked" },
    { workspace_id: WS, name: "Not Interested" },
    { workspace_id: WS, name: "Introduction" },
    { workspace_id: WS, name: "Unsubscribe" },
  ]);
  L = { interested: interested.id, meetings: meetings.id, notInterested: notInterested.id, introduction: introduction.id, unsubscribe: unsubscribe.id };
  const [jeff, wag, paused, demo, unknown] = db.seed("clients", [
    { name: "Jeff Cook Real Estate", slug: "jeff-cook-real-estate", aliases: [] },
    { name: "Wagner Realty", slug: "wagner-realty", aliases: [] },
    { name: "Sleepy Homes", slug: "sleepy-homes", aliases: [] },
    { name: "Demo Portal", slug: "demo-portal", aliases: [] },
    { name: "Unknown", slug: "unknown", aliases: [] },
  ]);
  P = { jeff: jeff.id, wag: wag.id, paused: paused.id, demo: demo.id, unknown: unknown.id };
  const [cJeff, cWag, cPaused, cDemo] = db.seed("os_clients", [
    {
      name: "Jeff Cook Real Estate", aliases: [], status: "active", mi_client_id: jeff.id, brokerage: "Jeff Cook Real Estate",
      contact_name: "Angela Oakes", contact_role: "Recruiter", contact_email: "angela@jeffcook.test",
      contact2_name: "Lance Overstreet", contact2_role: "Broker", contact2_email: "lance@jeffcook.test",
      contact3_name: "Stan Taylor", contact3_role: "Broker", contact3_email: "stan@jeffcook.test",
      contact_territories: { "1": ["Charlotte"], "2": ["Charleston", "Summerville"], "3": ["Charleston", "Summerville"] },
      more_contacts: [], intro_variants: [], relay_settings: jeffRelay, pipeline_entry: "introduction",
    },
    { name: "Wagner Realty", aliases: [], status: "active", mi_client_id: wag.id, contact_name: "Wendy Wagner", contact_role: "Owner", contact_email: "wendy@wagner.test", relay_settings: {}, pipeline_entry: "introduction" },
    { name: "Sleepy Homes", aliases: [], status: "paused", mi_client_id: paused.id, contact_name: "Pat", contact_role: "Owner", contact_email: "pat@sleepy.test", relay_settings: {} },
    { name: "Demo Portal", aliases: [], status: "active", mi_client_id: demo.id, contact_name: "Demo Person", contact_role: "Owner", contact_email: "demo@demo.test", relay_settings: {} },
  ]);
  C = { jeff: cJeff.id, wag: cWag.id, paused: cPaused.id, demo: cDemo.id };
  db.seed("os_relay_settings", [
    { workspace_id: WS, enabled: true, practice_mode: true, mode: "automatic", forward_later_replies: false, counts_as_introduction: false, hourly_cap: 5, enabled_since: GO_LIVE, ...settings },
  ]);
  for (const t of ["os_brokerage_relays", "os_brokerage_relay_agents", "os_relay_campaigns", "os_campaign_portals", "os_portal_blocks", "os_notifications",
    "leads", "threads", "messages", "label_assignments", "client_dnc_entries", "client_agents", "client_pipeline_entries"]) db.seed(t, []);
}

interface Conv {
  portal: string;
  campaign: string;
  campaignId?: string;
  name?: string;
  email?: string;
  text?: string;
  subject?: string;
  /** The agent's message's own subject (an auto-reply puts "Automatic reply:" here). */
  replySubject?: string;
  replyAt?: string;
}

function conversation(c: Conv) {
  const [lead] = add("leads", [{ full_name: c.name ?? "Jordan Ellis", email: c.email ?? "jordan@coastal.test" }]);
  const [thread] = add("threads", [{
    workspace_id: WS, client_id: c.portal, lead_id: lead.id, campaign_id: c.campaignId ?? "101", campaign_name: c.campaign,
    source_provider: "emailbison", subject: c.subject ?? "Quick question, Jordan",
  }]);
  const [outbound, reply] = add("messages", [
    { thread_id: thread.id, direction: "outbound", sender: "nicole.c@brokerstaffer.com", sender_name: "Nicole Collins", subject: "Quick question, Jordan", body_text: "Hi Jordan, I came across your listings and wanted to ask…", sent_at: at(-24 * 60) },
    { thread_id: thread.id, direction: "inbound", sender: c.email ?? "jordan@coastal.test", sender_name: c.name ?? "Jordan Ellis", subject: c.replySubject ?? "Re: Quick question, Jordan", body_text: c.text ?? "Sure, happy to chat. Mornings work best — (843) 555-0142.", sent_at: c.replyAt ?? at(-3), raw_payload: { data: { reply: { raw_message_id: "<agent-1@mail.test>" } } } },
  ]);
  return { lead, thread, outbound, reply };
}

function label(labelId: string, threadId: string, when = at(-2)) {
  add("label_assignments", [{ workspace_id: WS, label_id: labelId, target_type: "thread", target_id: threadId, assigned_at: when }]);
}

const CHARLESTON = "Jeff Cook Real Estate + Charleston, SC + ZF NS1";
const deps = (env: Env = {}) => ({ ws: WS, transport, env });
const records = () => db.rows("os_brokerage_relays");
const recordFor = (threadId: string) => records().find((r) => r.thread_id === threadId)!;

/** Nothing written outside the OS's own tables, and nothing sent to any host but the fake database. */
function assertContained() {
  const writes = db.calls.filter((c) => !["GET", "HEAD"].includes(c.method));
  assert.deepEqual(writes.filter((c) => !c.table.startsWith("os_")).map((c) => `${c.method} ${c.table}`), [], "only os_* tables are written");
  assert.deepEqual(db.blocked, [], "no request left for any other host");
}

/* ============================================================ the defaults */

test("PRACTICE (the default): decided, recorded with the full message, and the transport is never called", async () => {
  seed();
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);

  const r = await relay.sweepBrokerageRelay(NOW, deps());
  assert.deepEqual(r.outcomes, { practice: 1 }, JSON.stringify(r));
  assert.equal(handed.length, 0, "never handed to Postmark");

  const rec = recordFor(thread.id);
  assert.equal(rec.status, "practice");
  assert.equal(rec.practice, true);
  assert.equal(rec.os_client_id, C.jeff);
  assert.equal(rec.resolved_by, "campaign_name");
  assert.deepEqual((rec.recipients as Row[]).map((x) => x.email), ["lance@jeffcook.test", "stan@jeffcook.test"], "Charleston's people");
  assert.equal(rec.from_address, "agents@leads.brokerstaffer.com");
  assert.equal(rec.from_name, "Jordan Ellis via BrokerStaffer");
  assert.equal(rec.reply_to, '"Jordan Ellis" <jordan@coastal.test>');
  assert.equal(rec.subject, "Jordan Ellis is interested — reply to reach them");
  // Notification style (20 Oct): BrokerStaffer's line, then the agent's words — our outreach is not quoted.
  assert.ok(String(rec.text_body).startsWith("Jordan Ellis replied to your BrokerStaffer recruiting campaign and is interested.\nReply to this email to reach Jordan directly.\n\n----------\n\nSure, happy to chat."), String(rec.text_body));
  assert.doesNotMatch(String(rec.text_body), /Nicole Collins wrote|I came across your listings/);
  assert.deepEqual(rec.headers, [{ Name: "In-Reply-To", Value: "<agent-1@mail.test>" }, { Name: "References", Value: "<agent-1@mail.test>" }]);
  assert.equal(rec.pipeline_action, "none", "an existing client keeps entering at Introduction");
  assert.equal(rec.counts_as_introduction, false);
  assertContained();
});

test("practice even with every database switch open, while OS_BROKERAGE_RELAY_LIVE_SEND is unset — and the REAL transport is never reached", async () => {
  seed({ practice_mode: false }, { enabled: true });
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  // No fake transport: the relay builds the real Postmark one. Any request it made would land in db.blocked.
  const r = await relay.sweepBrokerageRelay(NOW, { ws: WS, env: {} });
  assert.deepEqual(r.outcomes, { practice: 1 });
  assert.equal(recordFor(thread.id).practice, true);
  assertContained();
});

test("practice when the env switch is on but Settings still says practice, or the brokerage's own switch is off", async () => {
  for (const [settings, jeffRelay, why] of [
    [{ practice_mode: true }, { enabled: true }, "practice mode"],
    [{ practice_mode: false }, {}, "brokerage switch off"],
  ] as const) {
    seed(settings, jeffRelay);
    const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
    label(L.interested, thread.id);
    const r = await relay.sweepBrokerageRelay(NOW, deps(LIVE));
    assert.deepEqual(r.outcomes, { practice: 1 }, why);
    assert.equal(handed.length, 0, why);
    assertContained();
  }
});

test("the global switch off: nothing at all — not read, not recorded", async () => {
  seed({ enabled: false, practice_mode: false }, { enabled: true });
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  const r = await relay.sweepBrokerageRelay(NOW, deps(LIVE));
  assert.equal(r.off, "switched off in Settings");
  assert.equal(records().length, 0);
  assert.equal(handed.length, 0);
  assertContained();
});

test("no settings row (never switched on), migration 0035 not run, or OS_BROKERAGE_RELAY=0: off", async () => {
  seed();
  db.seed("os_relay_settings", []);
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  assert.equal((await relay.sweepBrokerageRelay(NOW, deps(LIVE))).off, "switched off in Settings");
  db.missingTables.add("os_relay_settings");
  assert.equal((await relay.sweepBrokerageRelay(NOW, deps(LIVE))).off, "migration 0035 has not been run");
  db.missingTables.clear();
  seed();
  assert.equal((await relay.sweepBrokerageRelay(NOW, deps({ ...LIVE, OS_BROKERAGE_RELAY: "0" }))).off, "OS_BROKERAGE_RELAY=0");
  assert.equal(records().length, 0);
  assert.equal(handed.length, 0);
  assertContained();
});

/* ============================================================ live */

test("LIVE only with every lock open: handed to Postmark once, exactly as the plan shows it", async () => {
  seed({ practice_mode: false }, { enabled: true });
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  const r = await relay.sweepBrokerageRelay(NOW, deps(LIVE));
  assert.deepEqual(r.outcomes, { sent: 1 }, JSON.stringify(r));
  assert.equal(handed.length, 1);
  const e = handed[0];
  assert.equal(e.from, '"Jordan Ellis via BrokerStaffer" <agents@leads.brokerstaffer.com>');
  assert.equal(e.toHeader, '"Lance Overstreet" <lance@jeffcook.test>, "Stan Taylor" <stan@jeffcook.test>');
  assert.equal(e.replyTo, '"Jordan Ellis" <jordan@coastal.test>');
  assert.equal(e.subject, "Jordan Ellis is interested — reply to reach them");
  const rec = recordFor(thread.id);
  assert.equal(rec.status, "sent");
  assert.equal(rec.practice, false);
  assert.equal(rec.provider_message_id, "pm-1");
  assert.equal(e.metadata.relay_id, rec.id);
  // Next minute: nothing new.
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 60_000), deps(LIVE));
  assert.equal(handed.length, 1);
  assertContained();
});

test("a definite Postmark refusal frees the agent's slot so Try again works; an unknown outcome refuses a retry", async () => {
  seed({ practice_mode: false }, { enabled: true });
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  answer = { ok: false, gated: null, error: "Postmark refused (422, code 406): Inactive recipient", definite: true };
  await relay.sweepBrokerageRelay(NOW, deps(LIVE));
  let rec = recordFor(thread.id);
  assert.equal(rec.status, "failed");
  assert.equal(rec.reason, "send_failed");
  assert.equal(db.rows("os_brokerage_relay_agents").length, 0, "slot freed");

  answer = { ok: true, messageId: "pm-2", submittedAt: null };
  const v = await relay.sendToBrokerage(String(rec.id), thread.id, "amy@brokerstaffer.com", deps(LIVE), NOW);
  assert.equal(v.status, "sent");
  assert.equal(handed.length, 2);

  // Unknown outcome: may have gone — never retried, not even by a click.
  seed({ practice_mode: false }, { enabled: true });
  const c2 = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, c2.thread.id);
  answer = { ok: false, gated: null, error: "Postmark did not answer: socket hang up", definite: false };
  await relay.sweepBrokerageRelay(NOW, deps(LIVE));
  rec = recordFor(c2.thread.id);
  assert.equal(rec.reason, "send_unknown");
  assert.equal(db.rows("os_brokerage_relay_agents").length, 1, "slot kept: it may have been delivered");
  await assert.rejects(relay.sendToBrokerage(String(rec.id), c2.thread.id, "amy@brokerstaffer.com", deps(LIVE), NOW), /check Postmark/);

  // One of several addresses inactive (406): the others may have it — unknown too, said as such (21 Oct review).
  seed({ practice_mode: false }, { enabled: true });
  const c3 = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, c3.thread.id);
  answer = { ok: false, gated: null, error: "Postmark refused an inactive address (422, code 406): Found inactive addresses: angela@jeffcook.test.", definite: false, partial: true };
  await relay.sweepBrokerageRelay(NOW, deps(LIVE));
  rec = recordFor(c3.thread.id);
  assert.equal(rec.status, "failed");
  assert.equal(rec.reason, "send_partial");
  assert.equal(db.rows("os_brokerage_relay_agents").length, 1, "slot kept");
  await assert.rejects(relay.sendToBrokerage(String(rec.id), c3.thread.id, "amy@brokerstaffer.com", deps(LIVE), NOW), /check Postmark/);
  assertContained();
});

/* ============================================================ one click */

test("ONE CLICK (the default mode): the sweep prepares it; nothing goes until a person presses Send to brokerage", async () => {
  seed({ mode: "one_click", practice_mode: false }, { enabled: true });
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  const r = await relay.sweepBrokerageRelay(NOW, deps(LIVE));
  assert.deepEqual(r.outcomes, { ready: 1 });
  assert.equal(handed.length, 0);
  const rec = recordFor(thread.id);
  assert.equal(rec.status, "ready");
  assert.equal(db.rows("os_brokerage_relay_agents").length, 0, "a prepared hand-off claims nothing");

  const v = await relay.sendToBrokerage(String(rec.id), thread.id, "amy@brokerstaffer.com", deps(LIVE), NOW);
  assert.equal(v.status, "sent");
  assert.equal(v.decidedBy, "amy@brokerstaffer.com");
  assert.equal(handed.length, 1);
  await assert.rejects(relay.sendToBrokerage(String(rec.id), thread.id, "amy@brokerstaffer.com", deps(LIVE), NOW), /already sent/);
  assert.equal(handed.length, 1);
  assertContained();
});

test("one click in practice: the press records 'would have gone' and sends nothing", async () => {
  seed({ mode: "one_click" });
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps(LIVE));
  const v = await relay.sendToBrokerage(String(recordFor(thread.id).id), thread.id, "amy@brokerstaffer.com", deps(LIVE), NOW);
  assert.equal(v.status, "practice");
  assert.equal(handed.length, 0);
  assertContained();
});

test("a press re-checks: Interested taken off since the sweep prepared it → not sent", async () => {
  seed({ mode: "one_click", practice_mode: false }, { enabled: true });
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps(LIVE));
  db.seed("label_assignments", []);
  const v = await relay.sendToBrokerage(String(recordFor(thread.id).id), thread.id, "amy@brokerstaffer.com", deps(LIVE), NOW);
  assert.equal(v.status, "skipped");
  assert.equal(v.reason, "no_longer_interested");
  assert.equal(handed.length, 0);
});

/* ============================================================ once */

test("once per conversation: the next sweep, a re-label and Meetings Booked on top add nothing", async () => {
  seed();
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  label(L.interested, thread.id, at(0));
  label(L.meetings, thread.id, at(0));
  const again = await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 60_000), deps());
  assert.equal(again.claimed, 0);
  assert.equal(records().length, 1);
});

test("never twice: the same agent's second conversation with the same brokerage is skipped; another brokerage gets its own", async () => {
  seed();
  const a = conversation({ portal: P.jeff, campaign: CHARLESTON });
  const b = conversation({ portal: P.jeff, campaign: "Jeff Cook Real Estate + Summerville", campaignId: "102", email: "jordan@coastal.test" });
  const c = conversation({ portal: P.wag, campaign: "Wagner Realty - Miami agents", campaignId: "200", email: "jordan@coastal.test", subject: "Wagner?" });
  label(L.interested, a.thread.id, at(-3));
  label(L.interested, b.thread.id, at(-2));
  label(L.interested, c.thread.id, at(-1));
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(recordFor(a.thread.id).status, "practice");
  assert.equal(recordFor(b.thread.id).status, "skipped");
  assert.equal(recordFor(b.thread.id).reason, "already_delivered");
  assert.equal(recordFor(c.thread.id).status, "practice");
  // Only that conversation: Wagner's hand-off carries Wagner's reply, and nothing of Jeff Cook's conversation.
  assert.match(String(recordFor(c.thread.id).text_body), /Sure, happy to chat/);
  assert.doesNotMatch(String(recordFor(c.thread.id).text_body), /Jeff Cook|Charleston|I came across your listings/);
  assert.deepEqual((recordFor(c.thread.id).recipients as Row[]).map((x) => x.email), ["wendy@wagner.test"]);
  assertContained();
});

test("an attempt that stopped after claiming the agent (before 'sending') carries on — it is not 'already delivered' to itself", async () => {
  seed();
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  const [rec] = add("os_brokerage_relays", [{
    workspace_id: WS, dedupe_key: `handoff:${thread.id}`, kind: "handoff", thread_id: thread.id, trigger: "Interested", triggered_at: at(-2),
    status: "held", reason: "evaluating", practice: true, created_at: at(-10), updated_at: at(-10), attempts: 0, recipients: [],
  }]);
  add("os_brokerage_relay_agents", [{ workspace_id: WS, os_client_id: C.jeff, agent_email: "jordan@coastal.test", mode: "practice", relay_id: rec.id }]);
  const r = await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(r.rechecked, 1);
  assert.equal(recordFor(thread.id).status, "practice");
});

test("one click: an agent already handed to this brokerage is marked so at once, not offered a button", async () => {
  seed();
  const a = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, a.thread.id, at(-3));
  await relay.sweepBrokerageRelay(NOW, deps());
  db.seed("os_relay_settings", db.rows("os_relay_settings").map((r) => ({ ...r, mode: "one_click" })));
  const b = conversation({ portal: P.jeff, campaign: "Jeff Cook Real Estate + Summerville", campaignId: "102" });
  label(L.interested, b.thread.id, at(1));
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 2 * 60_000), deps());
  assert.equal(recordFor(b.thread.id).status, "skipped");
  assert.equal(recordFor(b.thread.id).reason, "already_delivered");
});

test("a conversation with no campaign at all is never guessed from the inbox: skipped", async () => {
  seed();
  const { thread } = conversation({ portal: P.jeff, campaign: "" });
  db.seed("threads", db.rows("threads").map((t) => (t.id === thread.id ? { ...t, campaign_id: null, campaign_name: null } : t)));
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.deepEqual([recordFor(thread.id).status, recordFor(thread.id).reason], ["skipped", "no_campaign"]);
});

test("practice does not use up the live delivery (claims are kept apart by mode)", async () => {
  seed();
  const a = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, a.thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.deepEqual(db.rows("os_brokerage_relay_agents").map((r) => r.mode), ["practice"]);
  // Pilot starts; the same agent's NEW conversation is live.
  db.seed("os_relay_settings", [{ workspace_id: WS, enabled: true, practice_mode: false, mode: "automatic", hourly_cap: 5, enabled_since: GO_LIVE }]);
  db.seed("os_clients", db.rows("os_clients").map((r) => (r.id === C.jeff ? { ...r, relay_settings: { enabled: true } } : r)));
  const b = conversation({ portal: P.jeff, campaign: "Jeff Cook Real Estate + Charlotte", campaignId: "103" });
  label(L.interested, b.thread.id, at(1));
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 2 * 60_000), deps(LIVE));
  assert.equal(recordFor(b.thread.id).status, "sent");
  assert.deepEqual((recordFor(b.thread.id).recipients as Row[]).map((x) => x.email), ["angela@jeffcook.test"], "Charlotte → Angela");
});

/* ============================================================ which brokerage */

test("unknown campaign: held on the short list; the team assigns it and it goes", async () => {
  seed();
  const { thread } = conversation({ portal: P.unknown, campaign: "Template Zillow Flex", campaignId: "900" });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(recordFor(thread.id).status, "held");
  assert.equal(recordFor(thread.id).reason, "unknown_campaign");

  const overview = await relay.relayOverview({ ws: WS, env: {} });
  assert.deepEqual(overview.held.map((h) => [h.campaignId, h.conversations]), [["900", 1]]);
  assert.equal(overview.server.liveSendAllowed, false);
  assert.equal(overview.server.tokenSet, false);

  const res = await relay.assignCampaign({ platform: "emailbison", campaignId: "900", campaignName: "Template Zillow Flex", osClientId: C.wag, ignore: false }, "amy@brokerstaffer.com", deps(), NOW);
  assert.deepEqual(res, { rechecked: 1, outcomes: { practice: 1 }, queued: 0 });
  const rec = recordFor(thread.id);
  assert.equal(rec.resolved_by, "team");
  assert.equal(rec.os_client_id, C.wag);
  assert.equal(db.rows("os_relay_campaigns")[0].decided_by, "amy@brokerstaffer.com");
  assert.equal(db.rows("os_campaign_portals").length, 0, "portal routing is never changed by the relay");
  assertContained();
});

test("'not a brokerage campaign' skips it for good", async () => {
  seed();
  const { thread } = conversation({ portal: P.unknown, campaign: "Not Interested - All Clients", campaignId: "901" });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  await relay.assignCampaign({ platform: "emailbison", campaignId: "901", campaignName: null, osClientId: null, ignore: true }, "amy@brokerstaffer.com", deps(), NOW);
  assert.equal(recordFor(thread.id).status, "skipped");
  assert.equal(recordFor(thread.id).reason, "ignored_campaign");
});

test("the campaign says one brokerage, the conversation is filed under another: held", async () => {
  seed();
  const { thread } = conversation({ portal: P.wag, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(recordFor(thread.id).reason, "campaign_conflict");
  assert.equal(recordFor(thread.id).detail, "Wagner Realty");

  // The team says it is the campaign's brokerage: the hold clears (21 Oct review — it used to stay held forever).
  await relay.assignCampaign({ platform: "emailbison", campaignId: "101", campaignName: CHARLESTON, osClientId: C.jeff, ignore: false }, "amy@brokerstaffer.com", deps(), NOW);
  const rec = recordFor(thread.id);
  assert.deepEqual([rec.status, rec.resolved_by, rec.os_client_id], ["practice", "team", C.jeff]);
  assertContained();
});

/* ============================================================ the checks */

async function outcomeOf(setup: (thread: Row & { id: string }, lead: Row & { id: string }) => void, conv: Partial<Conv> = {}) {
  seed();
  const { thread, lead } = conversation({ portal: P.jeff, campaign: CHARLESTON, ...conv });
  label(L.interested, thread.id);
  setup(thread, lead);
  await relay.sweepBrokerageRelay(NOW, deps(LIVE));
  assert.equal(handed.length, 0);
  assertContained();
  const r = recordFor(thread.id);
  return [r.status, r.reason, r.detail ?? null];
}

test("never for a paused or churned brokerage, or Demo Portal", async () => {
  seed();
  const a = conversation({ portal: P.paused, campaign: "Sleepy Homes - Tampa" });
  const b = conversation({ portal: P.demo, campaign: "Demo Portal test campaign", campaignId: "5" });
  label(L.interested, a.thread.id);
  label(L.interested, b.thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.deepEqual([recordFor(a.thread.id).status, recordFor(a.thread.id).reason, recordFor(a.thread.id).detail], ["skipped", "brokerage_not_active", "paused"]);
  assert.deepEqual([recordFor(b.thread.id).status, recordFor(b.thread.id).reason], ["skipped", "excluded"]);
});

test("never for an out-of-office or automatic reply", async () => {
  assert.deepEqual(await outcomeOf(() => {}, { text: "I am currently out of the office until Monday, 20 October." }), ["skipped", "auto_reply", null]);
  assert.deepEqual(await outcomeOf(() => {}, { replySubject: "Automatic reply: Quick question", text: "Thanks for your email." }), ["skipped", "auto_reply", null]);
});

test("never for an unsubscribe, in words or by label", async () => {
  assert.deepEqual(await outcomeOf(() => {}, { text: "Interested in nothing — please remove me from your list." }), ["skipped", "unsubscribe", null]);
  assert.deepEqual(await outcomeOf((t) => label(L.unsubscribe, t.id)), ["skipped", "stop_label", "Unsubscribe"]);
});

test("never for anyone on that brokerage's Do Not Contact list — by address, company domain or name", async () => {
  assert.deepEqual(await outcomeOf(() => add("client_dnc_entries", [{ client_id: P.jeff, kind: "agent", name: "J", email: "Jordan@Coastal.test" }])), ["skipped", "dnc", "by email"]);
  assert.deepEqual(await outcomeOf(() => add("client_dnc_entries", [{ client_id: P.jeff, kind: "company", name: "Coastal", domain: "coastal.test" }])), ["skipped", "dnc", "by domain"]);
  assert.deepEqual(await outcomeOf(() => add("client_dnc_entries", [{ client_id: P.jeff, kind: "agent", name: "Jordan Ellis", email: null }])), ["skipped", "dnc", "by name"]);
  // Another brokerage's list is not this brokerage's.
  assert.deepEqual(await outcomeOf(() => add("client_dnc_entries", [{ client_id: P.wag, kind: "agent", name: "Jordan Ellis", email: "jordan@coastal.test" }])), ["practice", null, null]);
});

test("not for an agent the brokerage already has, or one the team already introduced", async () => {
  assert.deepEqual(await outcomeOf(() => add("client_agents", [{ client_id: P.jeff, name: "Jordan Ellis", email: "jordan@coastal.test" }])), ["skipped", "their_agent", null]);
  // On My Agents under another address, or none — matched by first and last name (21 Oct review).
  assert.deepEqual(await outcomeOf(() => add("client_agents", [{ client_id: P.jeff, name: "Jordan A. Ellis", email: "jellis@old.test" }])), ["skipped", "their_agent", "by name"]);
  assert.deepEqual(await outcomeOf(() => add("client_agents", [{ client_id: P.jeff, name: "Jordan Ellis", email: null }])), ["skipped", "their_agent", "by name"]);
  // Another Ellis, or a Jordan on another brokerage's roster: not a match.
  assert.equal((await outcomeOf(() => add("client_agents", [{ client_id: P.jeff, name: "Sam Ellis", email: null }, { client_id: P.wag, name: "Jordan Ellis", email: null }])))[0], "practice", "handed off (practice)");
  // The brokerage's own team member.
  assert.deepEqual(await outcomeOf(() => add("client_team_members", [{ client_id: P.jeff, name: "Jordan Ellis", email: "JORDAN@coastal.test" }])), ["skipped", "their_staff", null]);
  assert.deepEqual(await outcomeOf((t) => label(L.introduction, t.id)), ["skipped", "already_introduced", "Introduction label"]);
  assert.deepEqual(await outcomeOf(() => add("client_pipeline_entries", [{ client_id: P.jeff, lead_email: "jordan@coastal.test", stage: "Introduction" }])), ["skipped", "already_introduced", "in their pipeline"]);
});

test("a DNC list that cannot be read holds — never 'assume fine'", async () => {
  const out = await outcomeOf(() => db.missingTables.add("client_dnc_entries"));
  assert.equal(out[0], "held");
  assert.equal(out[1], "read_error");
});

test("nobody with an address for that market: held until a contact is added", async () => {
  seed();
  db.seed("os_clients", db.rows("os_clients").map((r) => (r.id === C.wag ? { ...r, contact_email: null } : r)));
  const { thread } = conversation({ portal: P.wag, campaign: "Wagner Realty - Miami" });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(recordFor(thread.id).reason, "no_recipients");
  db.seed("os_clients", db.rows("os_clients").map((r) => (r.id === C.wag ? { ...r, contact_email: "wendy@wagner.test" } : r)));
  // A held one is looked at again every five minutes, not every minute.
  assert.equal((await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 60_000), deps())).rechecked, 0);
  const r = await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 6 * 60_000), deps());
  assert.equal(r.rechecked, 1);
  assert.equal(recordFor(thread.id).status, "practice");
});

test("one address of the brokerage's own, when it has chosen that", async () => {
  seed({}, { recipients: "address", address: "recruiting@jeffcook.test" });
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.deepEqual(recordFor(thread.id).recipients, [{ name: null, email: "recruiting@jeffcook.test" }]);
});

test("Meetings Booked counts; Not Interested never does", async () => {
  seed();
  const a = conversation({ portal: P.jeff, campaign: CHARLESTON });
  const b = conversation({ portal: P.wag, campaign: "Wagner Realty - Miami", email: "sam@x.test", name: "Sam Lee" });
  label(L.meetings, a.thread.id);
  label(L.notInterested, b.thread.id);
  const r = await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(r.seen, 1);
  assert.equal(recordFor(a.thread.id).trigger, "Meetings Booked");
  assert.equal(records().length, 1);
});

test("no backfill: labels from before the switch went on, or older than the window, are never handed off", async () => {
  seed({ enabled_since: at(-10) });
  const a = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, a.thread.id, at(-20));
  const r = await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(r.seen, 0);
  seed();
  const b = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, b.thread.id, at(-45));
  assert.equal((await relay.sweepBrokerageRelay(NOW, deps())).seen, 0);
  assert.equal(records().length, 0);
});

test("the hourly cap per brokerage: the third in an hour waits, and goes the next hour", async () => {
  seed({ hourly_cap: 2 });
  const convs = ["a@x.test", "b@x.test", "c@x.test"].map((email, i) => conversation({ portal: P.jeff, campaign: CHARLESTON, email, name: `Agent ${"ABC"[i]} Person` }));
  convs.forEach((c, i) => label(L.interested, c.thread.id, at(-3 + i)));
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.deepEqual(convs.map((c) => recordFor(c.thread.id).status), ["practice", "practice", "held"]);
  assert.equal(recordFor(convs[2].thread.id).reason, "hourly_cap");
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 61 * 60_000), deps());
  assert.equal(recordFor(convs[2].thread.id).status, "practice");
});

test("the client's pipeline-entry setting is recorded on the hand-off — and nothing is written to the portal", async () => {
  seed();
  db.seed("os_clients", db.rows("os_clients").map((r) => (r.id === C.jeff ? { ...r, pipeline_entry: "interested" } : r)));
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(recordFor(thread.id).pipeline_action, "enter_at_interested");
  assert.equal(db.rows("client_pipeline_entries").length, 0);
  assertContained();
});

test("a client without the 0036 column reads as today's behaviour", async () => {
  seed();
  db.seed("os_clients", db.rows("os_clients").map(({ pipeline_entry: _drop, ...r }) => r));
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(recordFor(thread.id).pipeline_action, "none");
});

/* ============================================================ later replies */

test("later replies: off by default; when switched on, relayed once each to the same people", async () => {
  seed();
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  add("messages", [{ thread_id: thread.id, direction: "inbound", sender: "jordan@coastal.test", sender_name: "Jordan Ellis", subject: "Re: Quick question, Jordan", body_text: "Also free Thursday.", sent_at: at(5) }]);
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 10 * 60_000), deps());
  assert.equal(records().length, 1, "off: nothing for the later reply");

  db.seed("os_relay_settings", db.rows("os_relay_settings").map((r) => ({ ...r, forward_later_replies: true })));
  const r = await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 11 * 60_000), deps());
  assert.equal(r.followUps, 1);
  const f = records().find((x) => x.kind === "follow_up")!;
  assert.equal(f.status, "practice", "a practised hand-off's later reply is practice too");
  assert.deepEqual((f.recipients as Row[]).map((x) => x.email), ["lance@jeffcook.test", "stan@jeffcook.test"]);
  assert.ok(String(f.text_body).startsWith("Jordan Ellis replied to your BrokerStaffer recruiting campaign and is interested.\nReply to this email to reach Jordan directly.\n\n----------\n\nAlso free Thursday."), String(f.text_body));
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 12 * 60_000), deps());
  assert.equal(records().filter((x) => x.kind === "follow_up").length, 1);
  assertContained();
});

test("a later reply to a hand-off that was only PRACTISED never goes live, even once the pilot is on", async () => {
  seed({ forward_later_replies: true });
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(recordFor(thread.id).status, "practice");
  // The pilot starts for this brokerage; the agent writes again.
  db.seed("os_relay_settings", db.rows("os_relay_settings").map((r) => ({ ...r, practice_mode: false })));
  db.seed("os_clients", db.rows("os_clients").map((r) => (r.id === C.jeff ? { ...r, relay_settings: { enabled: true } } : r)));
  add("messages", [{ thread_id: thread.id, direction: "inbound", sender: "jordan@coastal.test", sender_name: "Jordan Ellis", subject: "Re: Quick question, Jordan", body_text: "Any news?", sent_at: at(5) }]);
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 10 * 60_000), deps(LIVE));
  const f = records().find((x) => x.kind === "follow_up")!;
  assert.equal(f.status, "practice", "the brokerage never received the first one");
  assert.equal(handed.length, 0);
});

/* ============================================================ bounces + the record */

test("a bounce marks the hand-off and rings the OS bell", async () => {
  seed();
  add("os_brokerage_relays", [{ workspace_id: WS, dedupe_key: "handoff:t9", kind: "handoff", thread_id: "t9", status: "sent", practice: false, provider_message_id: "pm-9", sent_at: at(-60), brokerage_name: "Jeff Cook Real Estate", agent_name: "Jordan Ellis", os_client_id: null, recipients: [] }]);
  const r = await relay.sweepBrokerageRelay(NOW, {
    ...deps(),
    bounces: async () => ({ ok: true as const, bounces: [{ ID: 5, Type: "HardBounce", MessageID: "pm-9", Email: "angela@jeffcook.test", Description: "Mailbox does not exist" }] }),
  });
  assert.equal(r.bounced, 1);
  const rec = records()[0];
  assert.equal(rec.status, "bounced");
  assert.match(String(rec.error), /HardBounce — angela@jeffcook\.test: Mailbox does not exist/);
  const [n] = db.rows("os_notifications");
  assert.equal(n.kind, "relay_bounce");
  assert.equal(n.ref, "relay_bounce:5");
  assertContained();
});

test("the conversation's record: what reached whom, read without writing", async () => {
  seed();
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  const before = db.calls.length;
  const { available, records: recs } = await relay.threadRelays(thread.id);
  assert.equal(available, true);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].status, "practice");
  assert.deepEqual(recs[0].recipients.map((x) => x.name), ["Lance Overstreet", "Stan Taylor"]);
  assert.ok(db.calls.slice(before).every((c) => c.method === "GET"));
  db.missingTables.add("os_brokerage_relays");
  assert.deepEqual(await relay.threadRelays(thread.id), { available: false, records: [] });
});

test("a tab opened earlier cannot undo a newer change: the save says which version it saw, and is refused if it moved (21 Oct review)", async () => {
  seed();
  db.seed("os_relay_settings", []);
  const first = await relay.saveGlobalSettings({ enabled: true, ifUpdatedAt: null }, "eddy@brokerstaffer.com", { ws: WS }, NOW);
  const seenByTabA = first.updatedAt;
  // Admin B leaves practice and then hits the kill switch.
  const later = new Date(NOW.getTime() + 60_000);
  const b1 = await relay.saveGlobalSettings({ practiceMode: false, ifUpdatedAt: seenByTabA }, "amy@brokerstaffer.com", { ws: WS }, later);
  await relay.saveGlobalSettings({ enabled: false, ifUpdatedAt: b1.updatedAt }, "amy@brokerstaffer.com", { ws: WS }, new Date(later.getTime() + 60_000));
  // Admin A, on the tab opened before, changes only the cap: refused, and the kill switch stays.
  await assert.rejects(relay.saveGlobalSettings({ hourlyCap: 9, ifUpdatedAt: seenByTabA }, "admin@outreachify.io", { ws: WS }, new Date(later.getTime() + 120_000)), (e: Error & { status?: number }) => e.status === 409 && /changed by someone else/.test(e.message));
  const stored = db.rows("os_relay_settings")[0];
  assert.deepEqual([stored.enabled, stored.hourly_cap], [false, 5]);

  // One brokerage: the same, by the settings the page loaded.
  const loaded = (await relay.saveBrokerageSettings(C.jeff, { enabled: false }, { ws: WS })).relay;
  await relay.saveBrokerageSettings(C.jeff, { ifRelay: loaded, enabled: true }, { ws: WS });
  await assert.rejects(relay.saveBrokerageSettings(C.jeff, { ifRelay: loaded, hourlyCap: 3 }, { ws: WS }), (e: Error & { status?: number }) => e.status === 409);
  const row = db.rows("os_clients").find((r) => r.id === C.jeff)!;
  const kept = row.relay_settings as Row;
  assert.deepEqual([kept.enabled, kept.hourly_cap], [true, null], "the newer switch stands; the stale cap was not written");
  assertContained();
});

test("settings: saving the switches and a brokerage's settings writes only os tables, and switching on stamps the go-live", async () => {
  seed();
  db.seed("os_relay_settings", []);
  const g = await relay.saveGlobalSettings({ enabled: true }, "eddy@brokerstaffer.com", { ws: WS }, NOW);
  assert.equal(g.enabled, true);
  assert.equal(g.practiceMode, true, "on means practice until someone says otherwise");
  assert.equal(g.enabledSince, NOW.toISOString());
  await assert.rejects(relay.saveGlobalSettings({ hourlyCap: 0 }, "x", { ws: WS }, NOW), /hourlyCap/);
  const b = await relay.saveBrokerageSettings(C.jeff, { enabled: true, pipelineEntry: "interested" }, { ws: WS });
  assert.equal(b.relay.enabled, true);
  assert.equal(b.pipelineEntry, "interested");
  const row = db.rows("os_clients").find((r) => r.id === C.jeff)!;
  assert.deepEqual(row.relay_settings, { enabled: true, mode: null, recipients: "intro_contacts", address: null, hourly_cap: null });
  assert.equal(row.pipeline_entry, "interested");
  assertContained();
});

/* ============================================================ review fixes (17 Oct) */

/** A transport that takes a moment, so two evaluations overlap the way two requests would. */
function slowTransport(ms = 5): Transport {
  return {
    async send(email) {
      await new Promise((r) => setTimeout(r, ms));
      handed.push(email);
      return answer;
    },
  };
}

test("ONE SEND under a double press: two presses on the same hand-off at once send it once (review fix: send lock)", async () => {
  seed({ mode: "one_click", practice_mode: false }, { enabled: true });
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps(LIVE));
  const id = String(recordFor(thread.id).id);
  const d = { ws: WS, transport: slowTransport(), env: LIVE };
  // Two tabs, or two people, press at the same moment. Both pass the agent-slot claim (it is this record's own).
  const results = await Promise.allSettled([
    relay.sendToBrokerage(id, thread.id, "amy@brokerstaffer.com", d, NOW),
    relay.sendToBrokerage(id, thread.id, "eddy@brokerstaffer.com", d, NOW),
  ]);
  assert.equal(handed.length, 1, "Postmark is handed the email once");
  assert.ok(results.some((r) => r.status === "fulfilled" && r.value.status === "sent"), JSON.stringify(results.map((r) => r.status)));
  for (const r of results) if (r.status === "rejected") assert.match(String(r.reason), /already (sending|sent)/);
  assert.equal(recordFor(thread.id).status, "sent");
  assert.equal(recordFor(thread.id).attempts, 1);
  assertContained();
});

test("ONE SEND when two sweeps re-check the same interrupted hand-off at once (review fix: send lock)", async () => {
  seed({ practice_mode: false }, { enabled: true });
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id, at(-40)); // outside the window: only the re-check reaches it
  const [rec] = add("os_brokerage_relays", [{
    workspace_id: WS, dedupe_key: `handoff:${thread.id}`, kind: "handoff", thread_id: thread.id, trigger: "Interested", triggered_at: at(-40),
    status: "held", reason: "evaluating", practice: true, created_at: at(-40), updated_at: at(-40), attempts: 0, recipients: [],
  }]);
  // Two OS replicas (or a slow sweep overlapping the next) pick it up together.
  const d = { ws: WS, transport: slowTransport(), env: LIVE };
  await Promise.all([relay.sweepBrokerageRelay(NOW, d), relay.sweepBrokerageRelay(NOW, d)]);
  assert.equal(handed.length, 1);
  assert.equal(db.rows("os_brokerage_relays").find((r) => r.id === rec.id)!.status, "sent");
  assertContained();
});

test("a press sends only in the mode it showed: prepared in practice, now live → prepared again, nothing sent (review fix)", async () => {
  seed({ mode: "one_click" }, { enabled: true }); // practice: the button reads "Send to brokerage (practice)"
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps(LIVE));
  assert.equal(recordFor(thread.id).practice, true);
  // Practice is switched off before anyone presses the practice button.
  db.seed("os_relay_settings", db.rows("os_relay_settings").map((r) => ({ ...r, practice_mode: false })));
  const v = await relay.sendToBrokerage(String(recordFor(thread.id).id), thread.id, "amy@brokerstaffer.com", deps(LIVE), NOW);
  assert.equal(handed.length, 0, "the practice button never sends a real email");
  assert.equal(v.status, "ready");
  assert.equal(v.practice, false, "now offered as a real send");
  assert.match(String(v.notice), /now live — nothing was sent/);
  // A second, deliberate press sends.
  const again = await relay.sendToBrokerage(String(recordFor(thread.id).id), thread.id, "amy@brokerstaffer.com", deps(LIVE), NOW);
  assert.equal(again.status, "sent");
  assert.equal(again.notice, null);
  assert.equal(handed.length, 1);
  assertContained();
});

test("'Check again' on a held hand-off never sends in one-click mode — it prepares it (review fix)", async () => {
  seed({ mode: "one_click", practice_mode: false }, { enabled: true });
  db.seed("os_clients", db.rows("os_clients").map((r) => (r.id === C.jeff ? { ...r, contact2_email: null, contact3_email: null } : r)));
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps(LIVE));
  assert.equal(recordFor(thread.id).reason, "no_recipients", "Charleston's people have no address yet");
  db.seed("os_clients", db.rows("os_clients").map((r) => (r.id === C.jeff ? { ...r, contact2_email: "lance@jeffcook.test" } : r)));
  const v = await relay.sendToBrokerage(String(recordFor(thread.id).id), thread.id, "amy@brokerstaffer.com", deps(LIVE), NOW);
  assert.equal(v.status, "ready", "the button said Check again, not Send");
  assert.equal(handed.length, 0);

  // In practice too: Check again prepares (as the sweep would); it does not record a practice send nobody pressed.
  seed({ mode: "one_click" });
  db.seed("os_clients", db.rows("os_clients").map((r) => (r.id === C.jeff ? { ...r, contact2_email: null, contact3_email: null } : r)));
  const p = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, p.thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  db.seed("os_clients", db.rows("os_clients").map((r) => (r.id === C.jeff ? { ...r, contact2_email: "lance@jeffcook.test" } : r)));
  const pv = await relay.sendToBrokerage(String(recordFor(p.thread.id).id), p.thread.id, "amy@brokerstaffer.com", deps(), NOW);
  assert.equal(pv.status, "ready");
  assert.equal(db.rows("os_brokerage_relay_agents").length, 0, "nothing claimed by a check");
  assertContained();
});

test("DNC is matched on the brokerage's WHOLE list, the DNC tool's way (review fix)", async () => {
  // A suffix on the lead's name, accents on the entry: the old last-word query looked for "Jr." / "Núñez".
  assert.deepEqual(await outcomeOf(() => add("client_dnc_entries", [{ client_id: P.jeff, kind: "agent", name: "Jordan Ellis", email: null }]), { name: "Jordan Ellis Jr." }), ["skipped", "dnc", "by name"]);
  assert.deepEqual(await outcomeOf(() => add("client_dnc_entries", [{ client_id: P.jeff, kind: "agent", name: "José Núñez", email: null }]), { name: "Jose Nunez", email: "jose@coastal.test" }), ["skipped", "dnc", "by name"]);
  // A company domain typed as a link: the old exact-string query never matched it.
  assert.deepEqual(await outcomeOf(() => add("client_dnc_entries", [{ client_id: P.jeff, kind: "company", name: "Coastal", domain: "https://www.Coastal.test/team" }])), ["skipped", "dnc", "by domain"]);
  // An AGENT entry's domain is not a block (the DNC tool blocks an agent by address): another agent there still goes.
  assert.deepEqual(await outcomeOf(() => add("client_dnc_entries", [{ client_id: P.jeff, kind: "agent", name: "Pat Other", email: "pat@coastal.test", domain: "coastal.test" }])), ["practice", null, null]);
  // The match is past the old 200-row cap, and past a server page limit smaller than ours.
  assert.deepEqual(
    await outcomeOf(() => {
      db.pageLimit = 7;
      add("client_dnc_entries", Array.from({ length: 260 }, (_, i) => ({ client_id: P.jeff, kind: "agent", name: `Someone${i} Ellis`, email: null })));
      add("client_dnc_entries", [{ client_id: P.jeff, kind: "agent", name: "Jordan Ellis", email: null }]);
    }),
    ["skipped", "dnc", "by name"],
  );
});

test("a DNC list that does not arrive in full holds — never 'assume fine' (review fix)", async () => {
  const out = await outcomeOf(() => {
    add("client_dnc_entries", Array.from({ length: 3 }, (_, i) => ({ client_id: P.jeff, kind: "agent", name: `X${i} Y`, email: `x${i}@y.test` })));
    db.pageLimit = 1;
    db.claimedTotals.set("client_dnc_entries", 999_999); // the server promises rows that never come
  });
  assert.deepEqual(out.slice(0, 2), ["held", "read_error"]);
  assert.match(String(out[2]), /client_dnc_entries: 3 of 999999 rows read/);
});

test("an old conversation labelled again is not handed off — the reply must be recent at the label (review fix)", async () => {
  assert.deepEqual(await outcomeOf(() => {}, { replyAt: at(-20 * 24 * 60) }), ["skipped", "stale_reply", `replied ${at(-20 * 24 * 60).slice(0, 10)}`]);
  assert.deepEqual(await outcomeOf(() => {}, { replyAt: at(-3 * 24 * 60) }), ["practice", null, null], "three days is not old");
});

test("EmailBison's own 'automatic reply' flag skips it, whatever the words say (review fix)", async () => {
  const out = await outcomeOf((t) => {
    db.seed("messages", db.rows("messages").map((m) => (m.thread_id === t.id && m.direction === "inbound" ? { ...m, raw_payload: { data: { reply: { id: 1, raw_message_id: "<a@b.test>", automated_reply: true } } } } : m)));
  }, { text: "Thanks for reaching out, sounds good." });
  assert.deepEqual(out, ["skipped", "auto_reply", null]);
});

test("a short reply's quote header (Outlook's From:/Sent:) is not passed on as the agent's words (review fix)", async () => {
  seed();
  const { thread } = conversation({
    portal: P.jeff,
    campaign: CHARLESTON,
    text: "Yes, interested.\n\nFrom: Nicole Collins <nicole.c@brokerstaffer.com>\nSent: Monday, October 5, 2026 10:00 AM\nTo: Jordan Ellis\nSubject: Quick question, Jordan\n\nHi Jordan, I came across your listings",
  });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  const rec = recordFor(thread.id);
  assert.equal(String(rec.text_body), "Jordan Ellis replied to your BrokerStaffer recruiting campaign and is interested.\nReply to this email to reach Jordan directly.\n\n----------\n\nYes, interested.", "only the agent's own words, under BrokerStaffer's line");
  assert.doesNotMatch(String(rec.text_body), /nicole\.c@brokerstaffer\.com|^From:/m, "our sender inbox never appears in the brokerage's copy");
  assert.doesNotMatch(String(rec.html_body), /nicole\.c@brokerstaffer\.com/);
});

test("the sweep reads EVERY label in the window, works a burst through a slice a minute, and writes nothing when nothing is new (review fix)", async () => {
  seed();
  const convs = Array.from({ length: 120 }, (_, i) => conversation({ portal: P.jeff, campaign: CHARLESTON, email: `agent${i}@x.test`, name: `Agent${i} Person` }));
  for (const c of convs) label(L.interested, c.thread.id);
  db.pageLimit = 50; // a server page limit smaller than the window
  const first = await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(first.seen, 120, "every label, not a first page");
  assert.equal(first.claimed, 100);
  assert.match(first.errors.join(" "), /20 new label\(s\) left for the next sweep/);
  const second = await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 60_000), deps());
  assert.equal(second.claimed, 20);
  assert.equal(records().length, 120);
  const before = db.calls.length;
  const third = await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 2 * 60_000), deps());
  assert.equal(third.claimed, 0);
  assert.deepEqual(db.calls.slice(before).filter((c) => c.method !== "GET" && c.method !== "HEAD").map((c) => `${c.method} ${c.table}`), [], "nothing new: no writes at all");
  assertContained();
});

test("held hand-offs are re-checked least-recently-checked first — a pile that stays held cannot starve the rest (review fix)", async () => {
  seed();
  db.seed("os_clients", db.rows("os_clients").map((r) => (r.id === C.wag ? { ...r, contact_email: null } : r)));
  const convs = Array.from({ length: 30 }, (_, i) => conversation({ portal: P.wag, campaign: "Wagner Realty - Miami", email: `w${i}@x.test`, name: `Wag${i} Agent` }));
  for (const c of convs) label(L.interested, c.thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.ok(convs.every((c) => recordFor(c.thread.id).reason === "no_recipients"));
  const r1 = await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 6 * 60_000), deps());
  const r2 = await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 12 * 60_000), deps());
  assert.equal(r1.rechecked, 25);
  assert.equal(r2.rechecked, 25);
  const checkedAfterFirst = convs.filter((c) => String(recordFor(c.thread.id).updated_at) > NOW.toISOString()).length;
  assert.equal(checkedAfterFirst, 30, "all thirty were looked at again, not the same twenty-five twice");
});

test("bounces: an out-of-office is not one; a spam report says so; each failed address is recorded once (review fix)", async () => {
  seed();
  const base = { workspace_id: WS, kind: "handoff", status: "sent", practice: false, sent_at: at(-60), brokerage_name: "Jeff Cook Real Estate", agent_name: "Jordan Ellis", os_client_id: null };
  add("os_brokerage_relays", [
    { ...base, dedupe_key: "handoff:t7", thread_id: "t7", provider_message_id: "pm-7", recipients: [{ name: "A", email: "a@jc.test" }, { name: "B", email: "b@jc.test" }] },
    { ...base, dedupe_key: "handoff:t8", thread_id: "t8", provider_message_id: "pm-8", recipients: [{ name: "C", email: "c@jc.test" }] },
    { ...base, dedupe_key: "handoff:t9", thread_id: "t9", provider_message_id: "pm-9", recipients: [{ name: "D", email: "d@jc.test" }] },
  ]);
  const bounces = [
    { ID: 1, Type: "HardBounce", MessageID: "pm-7", Email: "a@jc.test" },
    { ID: 2, Type: "HardBounce", MessageID: "pm-7", Email: "b@jc.test" },
    { ID: 3, Type: "SpamComplaint", MessageID: "pm-8", Email: "c@jc.test" },
    { ID: 4, Type: "AutoResponder", MessageID: "pm-9", Email: "d@jc.test", Description: "Out of office" },
    { ID: 5, Type: "Transient", MessageID: "pm-9", Email: "d@jc.test" },
  ];
  const r = await relay.sweepBrokerageRelay(NOW, { ...deps(), bounces: async () => ({ ok: true as const, bounces }) });
  assert.equal(r.bounced, 3);
  const byPm = (pm: string) => records().find((x) => x.provider_message_id === pm)!;
  assert.equal(byPm("pm-9").status, "sent", "an out-of-office means it arrived");
  assert.equal(byPm("pm-8").status, "bounced");
  assert.match(String(byPm("pm-7").error), /a@jc\.test.*; HardBounce — b@jc\.test/);
  const notes = db.rows("os_notifications");
  assert.equal(notes.length, 3);
  assert.ok(notes.some((n) => /reported as spam/.test(String(n.title))));
  // The next poll adds nothing.
  const again = await relay.sweepBrokerageRelay(NOW, { ...deps(), bounces: async () => ({ ok: true as const, bounces }) });
  assert.equal(again.bounced, 0);
  assertContained();
});

test("a campaign answer re-checks 50 at once and hands the rest to the sweep — none is left on the held list (review fix)", async () => {
  seed();
  const convs = Array.from({ length: 53 }, (_, i) => conversation({ portal: P.unknown, campaign: "Template Zillow Flex", campaignId: "900", email: `z${i}@x.test`, name: `Zed${i} Agent` }));
  for (const c of convs) label(L.interested, c.thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(records().filter((x) => x.reason === "unknown_campaign").length, 53);
  const res = await relay.assignCampaign({ platform: "emailbison", campaignId: "900", campaignName: "Template Zillow Flex", osClientId: C.wag, ignore: false }, "amy@brokerstaffer.com", deps(), NOW);
  assert.equal(res.rechecked, 50);
  assert.equal(res.queued, 3);
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 60_000), deps());
  assert.equal(records().filter((x) => x.status === "held" && ["unknown_campaign", "evaluating"].includes(String(x.reason))).length, 0);
  assert.ok(records().every((x) => x.os_client_id === C.wag));
  assertContained();
});

test("later replies: found past a server page limit, and only conversations with something new are loaded (review fix)", async () => {
  seed({ forward_later_replies: true });
  const convs = ["a", "b", "c", "d"].map((x) => conversation({ portal: P.jeff, campaign: CHARLESTON, email: `${x}@x.test`, name: `${x.toUpperCase()}ndy Agent` }));
  for (const c of convs) label(L.interested, c.thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  assert.equal(records().filter((r) => r.status === "practice").length, 4);
  // Three of the four write again; the fourth does not.
  for (const c of convs.slice(0, 3)) {
    const lead = db.rows("leads").find((l) => l.id === c.lead.id)!;
    add("messages", [{ thread_id: c.thread.id, direction: "inbound", sender: lead.email, sender_name: lead.full_name, subject: "Re: Quick question, Jordan", body_text: "Also free Thursday.", sent_at: at(5) }]);
  }
  db.pageLimit = 2; // four hand-offs, two to a page
  const before = db.calls.length;
  const r = await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 10 * 60_000), deps());
  assert.equal(r.followUps, 3, "every hand-off read, not the first page");
  const loaded = new Set(db.calls.slice(before).filter((c) => c.table === "threads" && c.method === "GET").map((c) => c.query.get("id")));
  assert.equal(loaded.has(`eq.${convs[3].thread.id}`), false, "the quiet conversation is never loaded");
  assert.equal(loaded.size, 3);
  assertContained();
});

test("the campaign → portal routes are read in full: a route past the first page still decides the brokerage (review fix)", async () => {
  seed();
  db.seed("os_campaign_portals", [
    ...Array.from({ length: 5 }, (_, i) => ({ platform: "emailbison", campaign_id: `00${i}`, os_client_id: C.jeff, mi_client_id: P.jeff })),
    { platform: "emailbison", campaign_id: "900", os_client_id: C.wag, mi_client_id: P.wag },
  ]);
  db.pageLimit = 2;
  const { thread } = conversation({ portal: P.unknown, campaign: "Template Zillow Flex", campaignId: "900" });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  const rec = recordFor(thread.id);
  assert.deepEqual([rec.status, rec.resolved_by, rec.os_client_id], ["practice", "campaign_portal", C.wag]);
  assertContained();
});

test("a safety list that cannot be read stops the sweep before anything is decided — never read as empty (21 Oct review)", async () => {
  for (const table of ["os_portal_blocks", "os_relay_campaigns", "os_campaign_portals", "os_clients"]) {
    seed({ practice_mode: false }, { enabled: true });
    const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
    label(L.interested, thread.id);
    db.missingTables.add(table);
    const r = await relay.sweepBrokerageRelay(NOW, deps(LIVE));
    db.missingTables.clear();
    assert.ok(r.errors.some((e) => e.includes(table)), `${table}: the failure is reported`);
    assert.equal(r.claimed, 0, `${table}: nothing claimed, so the next sweep decides it`);
    assert.equal(handed.length, 0, `${table}: nothing sent`);
    const again = await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 60_000), deps(LIVE));
    assert.equal(again.claimed, 1, `${table}: decided once the read works`);
  }
  assertContained();
});

test("a later reply whose hand-off cannot be read right now is held and tried again — not skipped as 'gone' (review fix)", async () => {
  seed({ forward_later_replies: true });
  const { thread } = conversation({ portal: P.jeff, campaign: CHARLESTON });
  label(L.interested, thread.id);
  await relay.sweepBrokerageRelay(NOW, deps());
  const parentId = String(recordFor(thread.id).id);
  add("messages", [{ thread_id: thread.id, direction: "inbound", sender: "jordan@coastal.test", sender_name: "Jordan Ellis", subject: "Re: Quick question, Jordan", body_text: "Also free Thursday.", sent_at: at(5) }]);
  db.failWhen = (c) => c.table === "os_brokerage_relays" && c.method === "GET" && c.query.get("id") === `eq.${parentId}`;
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 10 * 60_000), deps());
  const f = () => records().find((x) => x.kind === "follow_up")!;
  assert.deepEqual([f().status, f().reason], ["held", "read_error"]);
  db.failWhen = null;
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 16 * 60_000), deps());
  assert.equal(f().status, "practice", "checked again once the read works");
  assertContained();
});

test("a brokerage's switch saves with 0035 run and 0036 not yet; asking for the pipeline entry then says to run 0036 (review fix)", async () => {
  seed();
  db.seed("os_clients", db.rows("os_clients").map(({ pipeline_entry: _drop, ...r }) => r));
  // Without 0036 the column does not exist: PostgREST refuses a write that names it.
  db.failWhen = (c) => c.table === "os_clients" && c.method === "PATCH" && JSON.stringify(db.calls[db.calls.length - 1].body ?? {}).includes("pipeline_entry");
  const b = await relay.saveBrokerageSettings(C.jeff, { enabled: true }, { ws: WS });
  assert.equal(b.relay.enabled, true);
  assert.equal(b.pipelineEntry, "introduction");
  await assert.rejects(relay.saveBrokerageSettings(C.jeff, { pipelineEntry: "interested" }, { ws: WS }));
  assertContained();
});
