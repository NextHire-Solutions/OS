/*
 * The cap and the hand-off together, nothing stubbed between them: the real relay with the real hook and the real run,
 * the switch set the way it would be set on Railway. Only the campaign toggle, Client Health's target and the label
 * write are fakes, and the only email channel is the fake transport.
 *
 * The test that matters: a third agent saying yes, with a cap of two, reaches nobody and costs nothing, and however
 * that reply later comes out, it is only billed if it really reached the client.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest, type Row } from "../../tools/master-inbox/test/fake-postgrest.ts";
import type { RelayEmail } from "../../tools/master-inbox/relay/message.ts";
import type { SendResult, Transport } from "../../tools/master-inbox/relay/postmark.ts";

configureFakeEnvironment("MASTER_INBOX_");
for (const v of ["OS_BROKERAGE_RELAY_LIVE_SEND", "POSTMARK_SERVER_TOKEN", "OS_BROKERAGE_RELAY_FROM", "OS_BROKERAGE_RELAY", "OS_LEAD_CAPS"]) delete process.env[v];
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const target = { value: 2 as unknown };
let targetFails = false;
mock.module("../../tools/client-health/supabase", {
  namedExports: {
    getSupabase: () => ({
      from: () => {
        const b = { select: () => b, eq: () => b, maybeSingle: async () => (targetFails ? { data: null, error: { message: "Client Health is down" } } : { data: { monthly_target: target.value }, error: null }) };
        return b;
      },
    }),
  },
});
mock.module("../../tools/client-health/campaign-toggle", {
  namedExports: {
    planToggle: async () => ({ willChange: [], skipped: [] }),
    liveCampaigns: async () => [],
    isSending: () => false,
    sharedWithOthers: async () => new Map(),
    pauseListed: async () => { throw new Error("no campaign is touched in these tests"); },
    resumeListed: async () => { throw new Error("no campaign is touched in these tests"); },
  },
});
mock.module("../../tools/master-inbox/inbox/apply-label", {
  namedExports: {
    applyLabelToThread: async (i: { threadId: string; labelId: string; workspaceId?: string }) => {
      // What the real one does: one label per conversation, and the database's trigger keeps the history (0080).
      const assigned_at = new Date(clock).toISOString();
      db.seed("label_assignments", [
        ...db.rows("label_assignments").filter((r) => r.target_id !== i.threadId),
        { workspace_id: WS, label_id: i.labelId, target_type: "thread", target_id: i.threadId, assigned_at },
      ]);
      db.rows("label_history").push({ id: db.rows("label_history").length + 1, thread_id: i.threadId, label_id: i.labelId, label_name: String(i.labelId).replace("lab-", ""), assigned_at, source: "trigger" });
      return { ok: true, labelName: null, isIntroduction: false, alreadyCarriedThisLabel: false, announced: false };
    },
  },
});

const relay = await import("../../tools/master-inbox/relay/relay.ts");
const billing = await import("./billing.ts");
const caps = await import("./caps.ts");

const WS = "00000000-0000-4000-8000-000000000001";
const HB = "20000000-0000-4000-8000-000000000001";
const OTHER = "20000000-0000-4000-8000-000000000002";
const PORTAL = "10000000-0000-4000-8000-000000000001";
const OTHER_PORTAL = "10000000-0000-4000-8000-000000000002";
const CAMPAIGN = "Homebase Real Estate + SoCal + ZF NS1";
const OTHER_CAMPAIGN = "Wagner Realty + Boston + ZF NS1";
const NOW = new Date("2026-11-05T15:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
let clock = NOW.getTime();

const handed: RelayEmail[] = [];
const transport: Transport = { async send(email: RelayEmail): Promise<SendResult> { handed.push(email); return { ok: true, messageId: `pm-${handed.length}`, submittedAt: null }; } };
const CAPS_ON = { OS_BROKERAGE_RELAY_LIVE_SEND: "1", OS_LEAD_CAPS: "1" };
const CAPS_OFF = { OS_BROKERAGE_RELAY_LIVE_SEND: "1" };
const deps = (env: Record<string, string>) => ({ ws: WS, transport, env });
const toClient = () => handed.filter((e) => JSON.stringify(e).includes("owner@homebase.test"));

function seed(o: { status?: string; settings?: Row; relay?: Row } = {}) {
  db.reset();
  handed.length = 0;
  clock = NOW.getTime();
  target.value = 2;
  targetFails = false;
  db.seed("workspaces", [{ id: WS }]);
  db.seed("labels", ["Interested", "Keep Warm", "Not Interested", "Introduction", "Unsubscribe", "Meetings Booked"].map((name) => ({ id: `lab-${name}`, workspace_id: WS, name })));
  db.seed("clients", [
    { id: PORTAL, name: "Homebase Real Estate", slug: "homebase", aliases: [] },
    { id: OTHER_PORTAL, name: "Wagner Realty", slug: "wagner-realty", aliases: [] },
  ]);
  db.seed("os_clients", [
    { id: HB, name: "Homebase Real Estate", aliases: [], status: o.status ?? "active", mi_client_id: PORTAL, ch_client_id: "ch-hb", brokerage: "Homebase Real Estate", contact_name: "Oona Owner", contact_role: "Owner", contact_email: "owner@homebase.test", relay_settings: { enabled: true }, pipeline_entry: "interested" },
    { id: OTHER, name: "Wagner Realty", aliases: [], status: "active", mi_client_id: OTHER_PORTAL, ch_client_id: "ch-wag", brokerage: "Wagner Realty", contact_name: "Wendy", contact_role: "Owner", contact_email: "wendy@wagner.test", relay_settings: { enabled: true }, pipeline_entry: "introduction" },
  ]);
  db.seed("os_relay_settings", [{ workspace_id: WS, enabled: true, practice_mode: false, mode: "automatic", forward_later_replies: false, counts_as_introduction: false, hourly_cap: 50, enabled_since: "2026-10-15T00:00:00.000Z", ...o.relay }]);
  db.seed("os_usage_billing_settings", [{ os_client_id: HB, enabled: true, test_only: false, price_cents: 25_000, every_days: 14, anchor_date: "2026-10-28", lead_source: "handoffs", stripe_customer_id: "cus_1", default_payment_method_id: "pm_1", card_label: "Visa", setup_session_id: null, ...o.settings }]);
  for (const t of ["os_usage_billing_periods", "os_cap_windows", "os_cap_held_leads", "os_notifications", "os_brokerage_relays", "os_brokerage_relay_agents", "os_relay_campaigns", "os_campaign_portals", "os_portal_blocks",
    "leads", "threads", "messages", "label_assignments", "label_history", "client_dnc_entries", "client_agents", "client_team_members", "client_pipeline_entries", "client_pipeline_stages"]) db.seed(t, []);
}

function agent(name: string, minutesAgo: number, o: { portal?: string; campaign?: string; label?: string; text?: string } = {}) {
  const portal = o.portal ?? PORTAL;
  const email = `${name.toLowerCase()}@agents.test`;
  const id = `t-${name}`;
  const label = o.label ?? "Interested";
  db.rows("leads").push({ id: `l-${name}`, full_name: `${name} Agent`, email });
  db.rows("threads").push({ id, workspace_id: WS, client_id: portal, lead_id: `l-${name}`, campaign_id: "101", campaign_name: o.campaign ?? CAMPAIGN, source_provider: "emailbison", subject: "Quick question", status: "open" });
  db.rows("messages").push(
    { id: `m-${name}-o`, thread_id: id, direction: "outbound", sender: "nicole.c@brokerstaffer.com", sender_name: "Nicole Collins", subject: "Quick question", body_text: "Hi, I came across your listings.", sent_at: ago(24 * 60) },
    { id: `m-${name}-i`, thread_id: id, direction: "inbound", sender: email, sender_name: `${name} Agent`, subject: "Re: Quick question", body_text: o.text ?? "Sure, happy to chat. Mornings work best.", sent_at: ago(minutesAgo + 1), raw_payload: { data: { reply: { raw_message_id: `<${name}@mail.test>` } } } },
  );
  const at = ago(minutesAgo);
  db.rows("label_assignments").push({ workspace_id: WS, label_id: `lab-${label}`, target_type: "thread", target_id: id, assigned_at: at });
  db.rows("label_history").push({ id: db.rows("label_history").length + 1, thread_id: id, label_id: `lab-${label}`, label_name: label, assigned_at: at, client_id: portal, lead_id: `l-${name}`, source: "trigger" });
  return id;
}
const rec = (thread: string) => db.rows("os_brokerage_relays").find((r: Row) => r.thread_id === thread) as Row;
const labelsOf = (thread: string) => db.rows("label_assignments").filter((r: Row) => r.target_id === thread).map((r: Row) => r.label_id);
const billed = async (now: Date, periodStart: string) => {
  const s = (await billing.loadSettings(HB))!;
  return billing.previewPeriod(HB, s, { now, periodStart });
};
/** The real send stamps the real clock; these tests run on their own, so it is put where the test's clock says. */
const sentAt = (thread: string, when: Date) => { rec(thread).sent_at = when.toISOString(); };
const threeWithThirdHeld = async () => {
  agent("Ann", 30); agent("Ben", 20);
  const cy = agent("Cy", 10);
  await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  assert.deepEqual([rec(cy).status, rec(cy).reason], ["held", "over_cap"]);
  return cy;
};
const press = (cy: string, when: Date = NOW, env: Record<string, string> = CAPS_ON) => relay.sendToBrokerage(String(rec(cy).id), cy, "amy@brokerstaffer.com", deps(env), when);
const LATER = new Date("2026-11-26T15:00:00.000Z");
const INVOICE_DAY = new Date("2026-11-11T15:00:00.000Z");
const NEXT_INVOICE_DAY = new Date("2026-12-10T15:00:00.000Z");

test("cap of 2, three say yes: two reach the client, the third reaches nobody and isn't billed", async () => {
  seed();
  const [ann, ben, cy] = [agent("Ann", 30), agent("Ben", 20), agent("Cy", 10)];
  const r = await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  assert.deepEqual(r.outcomes, { sent: 2, held: 1 }, JSON.stringify(r));
  assert.equal(handed.length, 2);
  assert.equal(rec(ann).status, "sent");
  assert.equal(rec(ben).status, "sent");
  assert.deepEqual([rec(cy).status, rec(cy).reason], ["held", "over_cap"]);
  assert.equal(JSON.stringify(handed).includes("cy@agents.test"), false, "nothing about the third agent went out");

  // Held properly: recorded, in Keep Warm, the team told; the once-per-agent slot untouched so it can still go later.
  assert.deepEqual(db.rows("os_cap_held_leads").map((h: Row) => [h.thread_id, h.window_start, h.released_at ?? null]), [[cy, "2026-10-28", null]]);
  assert.deepEqual(labelsOf(cy), ["lab-Keep Warm"]);
  assert.ok(db.rows("os_notifications").some((n: Row) => n.ref === `cap_held:${cy}`));
  assert.equal(db.rows("os_brokerage_relay_agents").some((a: Row) => JSON.stringify(a).includes("cy@agents.test")), false);

  const p = await billed(INVOICE_DAY, "2026-10-28");
  assert.deepEqual(p.leads.map((l) => l.name).sort(), ["Ann Agent", "Ben Agent"]);
  assert.equal(p.amountCents, 50_000);
});

test("the sweep looking at them newest first changes nothing: it goes by when they said yes", async () => {
  seed();
  const cy = agent("Cy", 10);
  const ben = agent("Ben", 20);
  const ann = agent("Ann", 30);
  await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  assert.equal(rec(cy).reason, "over_cap");
  assert.equal(rec(ann).status, "sent");
  assert.equal(rec(ben).status, "sent");
});

test("later sweeps leave the held reply alone: never sent by a retry, even after the label moved", async () => {
  seed();
  const cy = await threeWithThirdHeld();
  for (let i = 1; i <= 3; i += 1) await relay.sweepBrokerageRelay(new Date(NOW.getTime() + i * 15 * 60_000), deps(CAPS_ON));
  assert.equal(handed.length, 2);
  assert.equal(rec(cy).reason, "over_cap");
  assert.equal(db.rows("os_cap_held_leads").length, 1);
  assert.equal(db.rows("os_notifications").filter((n: Row) => n.ref === `cap_held:${cy}`).length, 1);
});

test("the switch off: exactly as today. All three go, and nothing about caps is even read", async () => {
  seed();
  agent("Ann", 30); agent("Ben", 20); agent("Cy", 10);
  db.calls.length = 0;
  const r = await relay.sweepBrokerageRelay(NOW, deps(CAPS_OFF));
  assert.deepEqual(r.outcomes, { sent: 3 });
  assert.equal(db.calls.some((c) => c.table.startsWith("os_cap") || c.table === "os_usage_billing_settings"), false);
});

test("the switch on, another client with no pay per lead: never held, however many", async () => {
  seed();
  for (const n of ["Una", "Vic", "Wes"]) agent(n, 10, { portal: OTHER_PORTAL, campaign: OTHER_CAMPAIGN });
  const r = await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  assert.deepEqual(r.outcomes, { sent: 3 });
  assert.deepEqual(db.rows("os_cap_held_leads"), []);
});

test("the switch on, a client still in test: its target is a goal, so nothing is held or relabelled", async () => {
  seed({ settings: { test_only: true } });
  const cy = (agent("Ann", 30), agent("Ben", 20), agent("Cy", 10));
  const r = await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  assert.deepEqual(r.outcomes, { sent: 3 });
  assert.deepEqual(db.rows("os_cap_held_leads"), []);
  assert.deepEqual(labelsOf(cy), ["lab-Interested"]);
});

test("the switch on, no target: nobody is held", async () => {
  for (const v of [0, null]) {
    seed();
    target.value = v;
    agent("Ann", 30); agent("Ben", 20); agent("Cy", 10);
    const r = await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
    assert.deepEqual(r.outcomes, { sent: 3 }, String(v));
  }
});

test("Client Health down: nobody goes, nobody is told they're over, and the next sweep sorts it out", async () => {
  seed();
  const [ann, ben, cy] = [agent("Ann", 30), agent("Ben", 20), agent("Cy", 10)];
  targetFails = true;
  const r = await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  assert.equal(handed.length, 0, JSON.stringify(r));
  assert.deepEqual(db.rows("os_cap_held_leads"), []);
  for (const t of [ann, ben, cy]) assert.equal(rec(t).reason, "read_error");
  targetFails = false;
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 15 * 60_000), deps(CAPS_ON));
  assert.equal(handed.length, 2);
  assert.equal(rec(cy).reason, "over_cap");
});

/* ------------------------------------------- the cases a review broke open --- */

test("the hold not finishing (a deploy, a blip): the reply still can't go, and the run finishes it", async () => {
  seed();
  agent("Ann", 30); agent("Ben", 20);
  const cy = agent("Cy", 10);
  db.failWhen = ({ method, table }) => method !== "GET" && table === "os_cap_held_leads";
  await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  db.failWhen = null;
  assert.equal(handed.length, 2);
  assert.deepEqual([rec(cy).status, rec(cy).reason], ["held", "over_cap"]);
  assert.deepEqual(db.rows("os_cap_held_leads"), []);
  // Sweeps never send it in the meantime.
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 6 * 60_000), deps(CAPS_ON));
  assert.equal(handed.length, 2);
  await caps.runLeadCaps({ env: CAPS_ON, now: new Date(NOW.getTime() + 15 * 60_000) });
  assert.deepEqual(db.rows("os_cap_held_leads").map((h: Row) => h.thread_id), [cy]);
  assert.deepEqual(labelsOf(cy), ["lab-Keep Warm"]);
  const p = await billed(INVOICE_DAY, "2026-10-28");
  assert.equal(p.amountCents, 50_000, "and it never reached the invoice");
});

test("a person labels the held reply Unsubscribe: the button refuses, the label stays, nothing is sent or billed", async () => {
  seed();
  const cy = await threeWithThirdHeld();
  db.seed("label_assignments", [...db.rows("label_assignments").filter((a: Row) => a.target_id !== cy), { workspace_id: WS, label_id: "lab-Unsubscribe", target_type: "thread", target_id: cy, assigned_at: LATER.toISOString() }]);
  await assert.rejects(press(cy, LATER), /now labelled Unsubscribe, so it wasn't sent/);
  assert.equal(handed.length, 2);
  assert.deepEqual(labelsOf(cy), ["lab-Unsubscribe"]);
  assert.equal(db.rows("os_cap_held_leads")[0].released_at ?? null, null);
  const p = await billed(NEXT_INVOICE_DAY, "2026-11-25");
  assert.deepEqual(p.leads, []);
});

test("the agent writes 'remove me' while it waits: the button refuses, even with no label to say so", async () => {
  seed();
  const cy = await threeWithThirdHeld();
  db.rows("messages").push({ id: "m-Cy-2", thread_id: cy, direction: "inbound", sender: "cy@agents.test", sender_name: "Cy Agent", subject: "Re: Quick question", body_text: "Please remove me from your list.", sent_at: new Date(NOW.getTime() + 86_400_000).toISOString() });
  await assert.rejects(press(cy, LATER), /asked to be removed since this was held/);
  assert.equal(handed.length, 2);
  assert.deepEqual(labelsOf(cy), ["lab-Keep Warm"]);
});

test("in practice: held and not billed; the button says it can't go yet, and nothing moves", async () => {
  seed({ relay: { practice_mode: true } });
  agent("Ann", 30); agent("Ben", 20);
  const cy = agent("Cy", 10);
  await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  assert.equal(handed.length, 0);
  assert.deepEqual([rec(cy).status, rec(cy).reason], ["held", "over_cap"]);
  await assert.rejects(press(cy, LATER), /in practice right now, so this can't be sent yet/);
  assert.deepEqual(labelsOf(cy), ["lab-Keep Warm"]);
  assert.equal(db.rows("os_cap_held_leads")[0].released_at ?? null, null);
  const p = await billed(INVOICE_DAY, "2026-10-28");
  assert.deepEqual(p.leads.map((l) => l.name).sort(), ["Ann Agent", "Ben Agent"]);
});

test("outside the pilot fence: the same", async () => {
  seed();
  const env = { ...CAPS_ON, OS_BROKERAGE_RELAY_LIVE_ONLY: "brokerstaffer.com" };
  agent("Ann", 30); agent("Ben", 20);
  const cy = agent("Cy", 10);
  await relay.sweepBrokerageRelay(NOW, deps(env));
  assert.equal(handed.length, 0);
  assert.equal(rec(cy).reason, "over_cap");
  await assert.rejects(press(cy, LATER, env), /in practice right now/);
});

test("onboarding and billed live: nothing goes to it, but a reply past the cap is still not charged", async () => {
  seed({ status: "onboarding" });
  const [ann, ben, cy] = [agent("Ann", 30), agent("Ben", 20), agent("Cy", 10)];
  await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  assert.equal(handed.length, 0);
  assert.equal(rec(ann).reason, "brokerage_not_active");
  assert.equal(rec(ben).reason, "brokerage_not_active");
  assert.deepEqual([rec(cy).status, rec(cy).reason], ["held", "over_cap"]);
  const p = await billed(INVOICE_DAY, "2026-10-28");
  assert.equal(p.amountCents, 50_000);
  await assert.rejects(press(cy, LATER), /isn't receiving hand-offs right now/);
  assert.deepEqual(labelsOf(cy), ["lab-Keep Warm"]);
});

test("pressed, and the checks then stop it (the client's own agent since): no email, and no charge", async () => {
  seed();
  const cy = await threeWithThirdHeld();
  db.rows("client_agents").push({ id: "ca1", client_id: PORTAL, email: "cy@agents.test", name: "Cy Agent" });
  clock = LATER.getTime();
  const view = await press(cy, LATER);
  assert.deepEqual([view.status, view.reason], ["skipped", "their_agent"]);
  assert.equal(handed.length, 2);
  assert.ok(db.rows("os_cap_held_leads")[0].released_at);
  const p = await billed(NEXT_INVOICE_DAY, "2026-11-25");
  assert.deepEqual(p.leads, [], "released, but it never went");
});

test("a press that dies partway (released, record not moved): nothing billed, and pressing again finishes it", async () => {
  seed();
  const cy = await threeWithThirdHeld();
  clock = LATER.getTime();
  db.failWhen = ({ method, table }) => method === "PATCH" && table === "os_brokerage_relays";
  await assert.rejects(press(cy, LATER));
  db.failWhen = null;
  assert.ok(db.rows("os_cap_held_leads")[0].released_at);
  assert.equal(rec(cy).reason, "over_cap");
  assert.deepEqual((await billed(NEXT_INVOICE_DAY, "2026-11-25")).leads, []);
  const view = await press(cy, LATER);
  assert.equal(view.status, "sent");
  assert.equal(handed.length, 3);
});

test("the button: refused at the cap, and in the new window it goes, is billed then, and counts then", async () => {
  seed();
  const cy = await threeWithThirdHeld();

  await assert.rejects(press(cy), /at its cap \(2 of 2\) until Nov 25, so this wasn't sent/);
  assert.equal(handed.length, 2);
  assert.equal(rec(cy).reason, "over_cap");
  assert.deepEqual(labelsOf(cy), ["lab-Keep Warm"]);

  clock = LATER.getTime();
  const view = await press(cy, LATER);
  assert.equal(view.status, "sent");
  assert.equal(view.notice, null);
  assert.equal(handed.length, 3);
  assert.deepEqual(labelsOf(cy), ["lab-Interested"]);
  const held = db.rows("os_cap_held_leads")[0];
  assert.equal(held.released_by, "amy@brokerstaffer.com");
  assert.equal(held.released_at, LATER.toISOString());
  sentAt(cy, LATER);

  // Not on the invoice for the period it was marked in, which may already be paid; on the one it went in.
  const old = await billed(INVOICE_DAY, "2026-10-28");
  assert.deepEqual(old.leads.map((l) => l.name).sort(), ["Ann Agent", "Ben Agent"]);
  const fresh = await billed(NEXT_INVOICE_DAY, "2026-11-25");
  assert.deepEqual(fresh.leads.map((l) => l.name), ["Cy Agent"]);

  // It uses one of the new window's two: the next is fine, the one after is held.
  const nowDec = new Date("2026-11-27T15:00:00.000Z");
  clock = nowDec.getTime();
  const dee = agent("Dee", -(nowDec.getTime() - NOW.getTime()) / 60_000 + 30);
  const eve = agent("Eve", -(nowDec.getTime() - NOW.getTime()) / 60_000 + 20);
  await relay.sweepBrokerageRelay(nowDec, deps(CAPS_ON));
  assert.equal(rec(dee).status, "sent");
  assert.deepEqual([rec(eve).status, rec(eve).reason], ["held", "over_cap"]);
});

test("the button with the cap raised: goes at once", async () => {
  seed();
  const cy = await threeWithThirdHeld();
  target.value = 3;
  const view = await press(cy);
  assert.equal(view.status, "sent");
  assert.equal(toClient().length, 3);
});

test("the switch turned off with a reply still held: the real path still lets a person send it, nothing is stranded", async () => {
  seed();
  const cy = await threeWithThirdHeld();
  clock = LATER.getTime();
  const view = await press(cy, LATER, CAPS_OFF);
  assert.equal(view.status, "sent");
  assert.equal(handed.length, 3);
});

test("Meetings Booked straight off, never Interested: not a billed lead, so at the cap it goes, unbilled, as it does today", async () => {
  seed();
  agent("Ann", 30); agent("Ben", 20);
  const mia = agent("Mia", 10, { label: "Meetings Booked" });
  await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  assert.equal(rec(mia).status, "sent");
  assert.deepEqual(labelsOf(mia), ["lab-Meetings Booked"], "a person's meeting label is never written over");
  const p = await billed(INVOICE_DAY, "2026-10-28");
  assert.equal(p.amountCents, 50_000);
});

/** Marked Interested, then a person moved it to Meetings Booked before the sweep looked at it. */
const interestedThenMeeting = (name: string, minutesAgo: number) => {
  const id = agent(name, minutesAgo);
  db.seed("label_assignments", [...db.rows("label_assignments").filter((a: Row) => a.target_id !== id), { workspace_id: WS, label_id: "lab-Meetings Booked", target_type: "thread", target_id: id, assigned_at: ago(minutesAgo - 1) }]);
  db.rows("label_history").push({ id: db.rows("label_history").length + 1, thread_id: id, label_id: "lab-Meetings Booked", label_name: "Meetings Booked", assigned_at: ago(minutesAgo - 1), client_id: PORTAL, lead_id: `l-${name}`, source: "trigger" });
  return id;
};

test("Interested first and then Meetings Booked, past the cap: billing would charge it, so it is held. The meeting label stays, and nothing is billed past the cap", async () => {
  seed();
  agent("Ann", 30); agent("Ben", 20);
  const cy = interestedThenMeeting("Cy", 10);
  await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  assert.equal(handed.length, 2);
  assert.deepEqual([rec(cy).status, rec(cy).reason], ["held", "over_cap"]);
  assert.deepEqual(labelsOf(cy), ["lab-Meetings Booked"]);
  assert.match(String(db.rows("os_notifications").find((n: Row) => n.ref === `cap_held:${cy}`)!.body), /keeps the label it has/);
  assert.equal((await billed(INVOICE_DAY, "2026-10-28")).amountCents, 50_000);
});

test("held with a meeting label: the button is refused at the cap, and with room it goes, keeps its label, and is billed then", async () => {
  seed();
  agent("Ann", 30); agent("Ben", 20);
  const cy = interestedThenMeeting("Cy", 10);
  await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  await assert.rejects(press(cy), /at its cap/);
  clock = LATER.getTime();
  const view = await press(cy, LATER);
  assert.equal(view.status, "sent");
  assert.deepEqual(labelsOf(cy), ["lab-Meetings Booked"], "a meeting stays a meeting");
  sentAt(cy, LATER);
  assert.deepEqual((await billed(NEXT_INVOICE_DAY, "2026-11-25")).leads.map((l) => l.name), ["Cy Agent"]);
});

test("pressed with room, stopped by the hourly limit, and the room goes meanwhile: it does not then run past the cap", async () => {
  seed({ relay: { hourly_cap: 2 } });
  const cy = await threeWithThirdHeld();
  target.value = 3;
  const view = await press(cy);
  assert.deepEqual([view.status, view.reason], ["held", "hourly_cap_click"]);
  assert.equal(handed.length, 2);
  assert.ok(db.rows("os_cap_held_leads")[0].released_at);

  // Dee takes the third place, and goes once the hour allows.
  const inAnHour = new Date(NOW.getTime() + 61 * 60_000);
  clock = inAnHour.getTime();
  const dee = agent("Dee", 5);
  await relay.sweepBrokerageRelay(new Date(NOW.getTime() + 2 * 60_000), deps(CAPS_ON));
  assert.equal(handed.length, 2);
  rec(cy).updated_at = new Date(inAnHour.getTime() - 30 * 60_000).toISOString();
  rec(dee).updated_at = new Date(inAnHour.getTime() - 30 * 60_000).toISOString();
  await relay.sweepBrokerageRelay(inAnHour, deps(CAPS_ON));

  assert.equal(JSON.stringify(handed).includes("cy@agents.test"), false, "Cy never went");
  assert.deepEqual([rec(cy).status, rec(cy).reason], ["held", "over_cap"]);
  assert.equal(db.rows("os_cap_held_leads").find((h: Row) => h.thread_id === cy)!.released_at, null);
  assert.deepEqual(labelsOf(cy), ["lab-Keep Warm"]);
  assert.ok(db.rows("os_notifications").some((n: Row) => String(n.ref).startsWith(`cap_reheld:${cy}`)));
});

test("two pressed with room for one, both stopped by the hourly limit, both looked at in one sweep: only one goes. The cap holds", async () => {
  seed({ relay: { hourly_cap: 2 } });
  const [ann, ben] = [agent("Ann", 30), agent("Ben", 20)];
  const cy = agent("Cy", 10);
  const dee = agent("Dee", 9);
  await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  assert.deepEqual([rec(ann).status, rec(ben).status, rec(cy).reason, rec(dee).reason], ["sent", "sent", "over_cap", "over_cap"]);
  target.value = 3;
  for (const t of [cy, dee]) assert.equal((await press(t)).reason, "hourly_cap_click");

  const inAnHour = new Date(NOW.getTime() + 61 * 60_000);
  clock = inAnHour.getTime();
  for (const t of [cy, dee]) rec(t).updated_at = new Date(inAnHour.getTime() - 30 * 60_000).toISOString();
  // The real send stamps the real clock: put each where the test's clock says, the moment it is recorded.
  db.failWhen = ({ table }) => {
    if (table === "os_brokerage_relays" || table === "os_cap_held_leads") for (const t of [cy, dee]) if (rec(t).status === "sent") rec(t).sent_at = inAnHour.toISOString();
    return false;
  };
  await relay.sweepBrokerageRelay(inAnHour, deps(CAPS_ON));
  db.failWhen = null;

  const statuses = [rec(cy), rec(dee)].map((r) => `${r.status}/${r.reason ?? ""}`).sort();
  assert.deepEqual(statuses, ["held/over_cap", "sent/"], JSON.stringify(statuses));
  assert.equal(handed.length, 3);
  const heldAgain = rec(cy).status === "sent" ? dee : cy;
  assert.equal(db.rows("os_cap_held_leads").find((h: Row) => h.thread_id === heldAgain)!.released_at, null);
  assert.deepEqual(labelsOf(heldAgain), ["lab-Keep Warm"]);
});

test("someone gave the held reply the Introduction label: the button says so, and doesn't advise a swap that would email them twice", async () => {
  seed();
  const cy = await threeWithThirdHeld();
  db.seed("label_assignments", [...db.rows("label_assignments").filter((a: Row) => a.target_id !== cy), { workspace_id: WS, label_id: "lab-Introduction", target_type: "thread", target_id: cy, assigned_at: LATER.toISOString() }]);
  await assert.rejects(press(cy, LATER), (e: Error) => /has already been introduced, so this wasn't sent/.test(e.message) && !/Keep Warm/.test(e.message));
  assert.equal(handed.length, 2);
});

test("pressed with room, stopped by the hourly limit, and there is still room: it goes by itself, and is billed", async () => {
  seed({ relay: { hourly_cap: 2 } });
  const cy = await threeWithThirdHeld();
  target.value = 3;
  await press(cy);
  const inAnHour = new Date(NOW.getTime() + 61 * 60_000);
  clock = inAnHour.getTime();
  rec(cy).updated_at = new Date(inAnHour.getTime() - 30 * 60_000).toISOString();
  await relay.sweepBrokerageRelay(inAnHour, deps(CAPS_ON));
  assert.equal(rec(cy).status, "sent");
  assert.equal(handed.length, 3);
});

test("a reply saying 'remove me' past the cap: never sent, not billed, and if pressed the check stops it", async () => {
  seed();
  agent("Ann", 30); agent("Ben", 20);
  const cy = agent("Cy", 10, { text: "Please remove me from your list." });
  await relay.sweepBrokerageRelay(NOW, deps(CAPS_ON));
  assert.equal(rec(cy).reason, "over_cap");
  clock = LATER.getTime();
  const view = await press(cy, LATER);
  assert.deepEqual([view.status, view.reason], ["skipped", "unsubscribe"]);
  assert.equal(handed.length, 2);
  assert.deepEqual((await billed(NEXT_INVOICE_DAY, "2026-11-25")).leads, []);
});

test("nothing here left the process", () => {
  assert.deepEqual(db.blocked, []);
});
