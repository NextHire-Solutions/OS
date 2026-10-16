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
  assert.equal(rec.subject, "Re: Quick question, Jordan");
  assert.ok(String(rec.text_body).startsWith("Sure, happy to chat."));
  assert.match(String(rec.text_body), /Nicole Collins wrote:\n> Hi Jordan/);
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
  assert.equal(e.subject, "Re: Quick question, Jordan");
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
  // Only that conversation: Wagner's hand-off quotes Wagner's conversation, never Jeff Cook's.
  assert.equal(recordFor(c.thread.id).subject, "Re: Wagner?");
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
  assert.deepEqual(res, { rechecked: 1, outcomes: { practice: 1 } });
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
  const r = await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 60_000), deps());
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
  assert.ok(String(f.text_body).startsWith("Also free Thursday."));
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
