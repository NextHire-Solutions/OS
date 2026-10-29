/*
 * A reply filed with the email it answers (29 Oct), end to end against the fake PostgREST and a fake EmailBison.
 *
 * Nicole sent an introduction to Jeffrey (Rise Real Estate Tujunga) from his conversation, CC'ing Sergei — Rise's own
 * team lead. Sergei replied. EmailBison knew him as a lead in The Rafeh Group's campaign, so the webhook keyed the reply
 * to "Sergei + Rafeh", and the conversation backfill MOVED the introduction into that new conversation: Jeffrey's lost it,
 * a "Rafeh" hand-off appeared. Run: node --import ./scripts/alias-hooks.mjs --test <this file>
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
const WS = "ws-1";

// EmailBison, by path: the conversation, our sender addresses, the lead's campaign emails.
const ebCalls: string[] = [];
let conversation: Record<string, unknown> = {};
let leadSent: unknown[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.host !== "emailbison.test") return db.fetch(input as string, init);
  ebCalls.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}${url.search}`);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname.endsWith("/switch-workspace")) return json({ data: { name: "BrokerStaffer" } });
  if (url.pathname === "/api/sender-emails") return json({ data: url.searchParams.get("page") === "1" ? [{ id: 7, email: "nicole.c@brokerstaffer.com" }] : [] });
  if (/\/api\/replies\/\d+\/conversation-thread$/.test(url.pathname)) return json({ data: conversation });
  if (/\/api\/leads\/\d+\/sent-emails$/.test(url.pathname)) return json({ data: leadSent });
  return json({ data: [] });
}) as typeof fetch;
const infos: string[] = [];
const logs: string[] = [];
for (const m of ["warn", "error"] as const) mock.method(console, m, () => {});
mock.method(console, "log", (...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
mock.method(console, "info", (...a: unknown[]) => { infos.push(a.map(String).join(" ")); });

let handle: ((e: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>) | null = null;
try {
  handle = (await import("@/lib/tools/master-inbox/sync/emailbison")).handleEmailBisonEvent;
} catch (err) {
  if ((err as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw err;
}
const skip = handle ? false : "needs the @/ alias hooks: node --import ./scripts/alias-hooks.mjs --test";

/** The background pipeline, finished: polls until `done` or a second has passed. */
async function settle(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
}

const INTRO = { id: 2552502, from_email_address: "nicole.c@brokerstaffer.com", from_name: "Nicole Collins", subject: "Intro: Jeffrey & Rise Real Estate Tujunga", html_body: "<div>Hey Jeffrey,</div>", text_body: "Hey Jeffrey,", to: [{ address: "jeff@firstsourcecare.com" }], cc: [{ address: "nicole.c@brokerstaffer.com" }, { address: "SergeiHovsepyan@outlook.com" }], date_received: "2026-10-29T13:10:56.000Z" };
const SERGEI = { id: 2553538, email_subject: "Re: Intro: Jeffrey & Rise Real Estate Tujunga", subject: "Re: Intro: Jeffrey & Rise Real Estate Tujunga", html_body: "<p>Hello Jeffrey, pleasure to meet you!</p>", text_body: "Hello Jeffrey, pleasure to meet you!", from_name: "Sergei Hovsepyan", from_email_address: "SergeiHovsepyan@outlook.com", to: [{ address: "nicole.c@brokerstaffer.com" }, { address: "jeff@firstsourcecare.com" }], date_received: "2026-10-29T14:59:06.000Z" };
const RAFEH = { id: 264, name: "The Rafeh Group 1 + Santa Clarita & Antelope Valley + ZF NS1 (PST)" };
const SERGEI_LEAD = { id: 125733, email: "sergeihovsepyan@outlook.com", first_name: "Sergei", last_name: "Hovsepyan" };
const RAFEH_EMAILS = [{ id: 501, campaign_id: 264, sent_at: "2026-09-18T18:34:00.000Z", email_subject: "Confidential conversation?", email_body: "<p>Rafeh outreach</p>", sender_email: { email: "nicole@howerealtyteam.com" } }];
const envelope = (reply: Record<string, unknown>, lead: Record<string, unknown>, campaign: Record<string, unknown>) => ({
  event: { type: "LEAD_REPLIED", name: "Lead replied", workspace_id: 7, workspace_name: "BrokerStaffer" },
  data: { lead, campaign, sender_email: { id: 7, email: "nicole.c@brokerstaffer.com", name: "Nicole Collins" }, reply },
});
const where = (ext: string) => db.rows("messages").find((m) => m.external_message_id === ext)?.thread_id;
const agentRan = (id: string) => logs.some((l) => l.startsWith(`[agents] thread ${id}`) || l.startsWith(`[agent] thread ${id}`));

/** Jeffrey's Rise conversation, holding his reply and Nicole's introduction (To Jeffrey, CC Nicole + Sergei). */
function seedJeffrey(introRecipients: Record<string, string[]> = { to: ["jeff@firstsourcecare.com"], cc: ["nicole.c@brokerstaffer.com", "SergeiHovsepyan@outlook.com"] }) {
  db.reset();
  db.seed("workspaces", [{ id: WS, created_at: "2026-01-01T00:00:00.000Z" }]);
  db.seed("clients", [
    { id: "client-unknown", name: "Unknown", slug: "unknown", aliases: [] },
    { id: "client-rise", name: "Rise Real Estate Tujunga", slug: "rise-tujunga", aliases: [] },
    { id: "client-rafeh", name: "The Rafeh Group", slug: "rafeh", aliases: [] },
  ]);
  const [jeff] = db.seed("leads", [{ workspace_id: WS, email: "jeff@firstsourcecare.com", full_name: "Jeffrey Holland", emailbison_lead_id: "52485" }]);
  const [thread] = db.seed("threads", [{ workspace_id: WS, lead_id: jeff.id, emailbison_thread_id: "eb:lead:52485:campaign:840", client_id: "client-rise", subject: "Re: Jeffrey?", last_message_at: "2026-10-29T13:10:56.000Z", needs_reply: false, seen: true, created_at: "2026-10-29T00:11:42.000Z" }]);
  db.seed("messages", [
    { workspace_id: WS, thread_id: thread.id, direction: "inbound", external_message_id: "eb:reply:2552250", sender: "jeff@firstsourcecare.com", sent_at: "2026-10-29T00:11:00.000Z", recipients: { to: ["nicole.c@brokerstaffer.com"] } },
    { workspace_id: WS, thread_id: thread.id, direction: "outbound", external_message_id: "eb:reply:2552502", emailbison_reply_id: "2552502", sender: "nicole.c@brokerstaffer.com", subject: INTRO.subject, sent_at: "2026-10-29T13:10:56.000Z", recipients: introRecipients },
  ]);
  ebCalls.length = 0;
  infos.length = 0;
  logs.length = 0;
  return thread.id as string;
}

test("Sergei (CC'd) answers the introduction: filed with it in Jeffrey's conversation, left to a person; no Rafeh conversation left", { skip }, async () => {
  const jeff = seedJeffrey();
  conversation = { older_messages: [INTRO], current_reply: SERGEI, newer_messages: [] };
  leadSent = RAFEH_EMAILS;
  assert.deepEqual(await handle!(envelope(SERGEI, SERGEI_LEAD, RAFEH)), { ok: true });
  await settle(() => infos.some((l) => l.includes("left to a person")));
  assert.equal(where("eb:reply:2553538"), jeff, "Sergei's reply is in Jeffrey's conversation");
  assert.equal(where("eb:reply:2552502"), jeff, "the introduction stays where it was sent from");
  assert.equal(db.rows("threads").filter((t) => t.emailbison_thread_id === "eb:lead:125733:campaign:264").length, 0, "the Rafeh conversation the webhook made is removed");
  assert.ok(!ebCalls.some((c) => c.includes("/sent-emails")) && !db.rows("messages").some((m) => m.external_message_id === "eb:sched:501"), "Rafeh's campaign emails are not pulled in");
  const t = db.rows("threads").find((x) => x.id === jeff)!;
  assert.deepEqual([t.needs_reply, t.seen, t.last_message_at], [true, false, "2026-10-29T14:59:06.000Z"]);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(!agentRan(jeff) && !logs.some((l) => /^\[agents?\] thread/.test(l)), `no reply agent on a CC'd person's reply: ${J(logs)}`);
});

test("Jeffrey himself (on To) answering under another EmailBison key — a follow-up campaign: filed as before, its campaign's emails and all", { skip }, async () => {
  const jeff = seedJeffrey();
  const JEFF_REPLY = { ...SERGEI, id: 2554000, from_name: "Jeffrey Holland", from_email_address: "jeff@firstsourcecare.com", text_body: "Thanks!", html_body: "<p>Thanks!</p>" };
  conversation = { older_messages: [INTRO], current_reply: JEFF_REPLY, newer_messages: [] };
  leadSent = [{ id: 950, campaign_id: 900, sent_at: "2026-10-29T14:00:00.000Z", email_subject: "Following up", email_body: "<p>Following up</p>", sender_email: { email: "nicole.c@brokerstaffer.com" } }];
  await handle!(envelope(JEFF_REPLY, { id: 99001, email: "jeff@firstsourcecare.com", first_name: "Jeffrey" }, { id: 900, name: "Some follow-up campaign" }));
  const own = () => db.rows("threads").find((t) => t.emailbison_thread_id === "eb:lead:99001:campaign:900");
  await settle(() => !!own() && where("eb:sched:950") === own()!.id && agentRan(own()!.id as string));
  assert.equal(where("eb:reply:2554000"), own()!.id, "his reply in the follow-up campaign's conversation, as before");
  assert.equal(where("eb:sched:950"), own()!.id, "with the follow-up email he answered");
  assert.equal(where("eb:reply:2552502"), jeff, "the introduction never moves");
  assert.ok(agentRan(own()!.id as string), `handled as the lead: ${J(logs)}`);
});

test("the same webhook delivered twice: Sergei's reply once, in Jeffrey's conversation — no Rafeh conversation left behind", { skip }, async () => {
  const jeff = seedJeffrey();
  conversation = { older_messages: [INTRO], current_reply: SERGEI, newer_messages: [] };
  leadSent = [];
  for (let i = 0; i < 2; i++) {
    infos.length = 0;
    await handle!(envelope(SERGEI, SERGEI_LEAD, RAFEH));
    await settle(() => infos.some((l) => l.includes("left to a person")) && !db.rows("threads").some((t) => t.emailbison_thread_id === "eb:lead:125733:campaign:264"));
  }
  assert.equal(db.rows("messages").filter((m) => m.external_message_id === "eb:reply:2553538").length, 1);
  assert.equal(where("eb:reply:2553538"), jeff);
  assert.equal(db.rows("threads").filter((t) => t.emailbison_thread_id === "eb:lead:125733:campaign:264").length, 0, "no empty Rafeh conversation after the replay");
});

test("someone on neither To nor Cc of our email is filed as before (never follows it)", { skip }, async () => {
  const jeff = seedJeffrey();
  const STRANGER = { ...SERGEI, id: 2555000, from_name: "Bo", from_email_address: "bo@example.com" };
  conversation = { older_messages: [INTRO], current_reply: STRANGER, newer_messages: [] };
  leadSent = [];
  await handle!(envelope(STRANGER, { id: 5151, email: "bo@example.com", first_name: "Bo" }, { id: 6, name: "Another" }));
  const own = () => db.rows("threads").find((t) => t.emailbison_thread_id === "eb:lead:5151:campaign:6");
  await settle(() => ebCalls.some((c) => c.includes("/sent-emails")));
  assert.equal(where("eb:reply:2555000"), own()!.id, "in Bo's own conversation");
  assert.equal(where("eb:reply:2552502"), jeff, "the introduction never moves");
});

test("an email an earlier sync misfiled (not with its To person) is not followed", { skip }, async () => {
  // The introduction sits in Jeffrey's conversation but was sent To someone else: misfiled — Sergei's reply is not pulled there.
  const jeff = seedJeffrey({ to: ["raulrpneto@gmail.com"], cc: ["SergeiHovsepyan@outlook.com"] });
  conversation = { older_messages: [INTRO], current_reply: SERGEI, newer_messages: [] };
  leadSent = [];
  await handle!(envelope(SERGEI, SERGEI_LEAD, RAFEH));
  const own = () => db.rows("threads").find((t) => t.emailbison_thread_id === "eb:lead:125733:campaign:264");
  await settle(() => ebCalls.some((c) => c.includes("/sent-emails")));
  assert.equal(where("eb:reply:2553538"), own()!.id, "filed as before");
  assert.equal(where("eb:reply:2552502"), jeff, "and nothing moved");
});

test("a reply moved out of a conversation that already existed leaves it exactly as it was", { skip }, async () => {
  const jeff = seedJeffrey();
  const [sergeiLead] = db.seed("leads", [...db.rows("leads"), { workspace_id: WS, email: "sergeihovsepyan@outlook.com", full_name: "Sergei Hovsepyan", emailbison_lead_id: "125733" }]).slice(-1);
  const prior = { workspace_id: WS, lead_id: sergeiLead.id, emailbison_thread_id: "eb:lead:125733:campaign:264", client_id: "client-rafeh", subject: "Re: Confidential conversation?", last_message_at: "2026-09-20T10:00:00.000Z", last_message_preview: "Not right now", needs_reply: false, seen: true, outbound_sender_email: "nicole@howerealtyteam.com", campaign_id: "264", campaign_name: RAFEH.name, created_at: "2026-09-20T10:00:00.000Z" };
  const [old] = db.seed("threads", [...db.rows("threads"), prior]).slice(-1);
  db.seed("messages", [...db.rows("messages"), { workspace_id: WS, thread_id: old.id, direction: "inbound", external_message_id: "eb:reply:1000", sender: "sergeihovsepyan@outlook.com", sent_at: "2026-09-20T10:00:00.000Z" }]);
  conversation = { older_messages: [INTRO], current_reply: SERGEI, newer_messages: [] };
  leadSent = [];
  await handle!(envelope(SERGEI, SERGEI_LEAD, RAFEH));
  await settle(() => infos.some((l) => l.includes("left to a person")));
  assert.equal(where("eb:reply:2553538"), jeff);
  const after = db.rows("threads").find((t) => t.id === old.id)!;
  assert.ok(after, "the conversation that already existed is kept");
  for (const k of ["needs_reply", "seen", "last_message_at", "last_message_preview", "outbound_sender_email", "subject", "lead_id"] as const) assert.deepEqual(after[k], (prior as Record<string, unknown>)[k], k);
  assert.equal(where("eb:reply:1000"), old.id, "its own message stays");
  // …and a replay of the same webhook puts it back again.
  infos.length = 0;
  await handle!(envelope(SERGEI, SERGEI_LEAD, RAFEH));
  await settle(() => db.rows("threads").find((t) => t.id === old.id)?.needs_reply === false && infos.some((l) => l.includes("left to a person")));
  const again = db.rows("threads").find((t) => t.id === old.id)!;
  for (const k of ["needs_reply", "seen", "last_message_at", "last_message_preview"] as const) assert.deepEqual(again[k], (prior as Record<string, unknown>)[k], `after the replay: ${k}`);
});

test("an ordinary reply is filed as before: its own conversation, its campaign's emails, the reply agent", { skip }, async () => {
  seedJeffrey();
  const reply = { id: 777, email_subject: "Re: Hi", subject: "Re: Hi", html_body: "<p>Sure</p>", text_body: "Sure", from_name: "Ana", from_email_address: "ana@example.com", to: [{ address: "nicole.c@brokerstaffer.com" }], date_received: "2026-10-29T15:00:00.000Z" };
  conversation = { older_messages: [], current_reply: reply, newer_messages: [] };
  leadSent = [{ id: 900, campaign_id: 5, sent_at: "2026-10-28T10:00:00.000Z", email_subject: "Hi", email_body: "<p>Hi Ana</p>", sender_email: { email: "nicole.c@brokerstaffer.com" } }];
  await handle!(envelope(reply, { id: 4242, email: "ana@example.com", first_name: "Ana" }, { id: 5, name: "Some Campaign" }));
  const own = () => db.rows("threads").find((t) => t.emailbison_thread_id === "eb:lead:4242:campaign:5");
  await settle(() => !!own() && db.rows("messages").some((m) => m.external_message_id === "eb:sched:900") && agentRan(own()!.id as string));
  const id = own()!.id as string;
  assert.equal(where("eb:reply:777"), id);
  assert.equal(where("eb:sched:900"), id, "its campaign's email is in its conversation");
  assert.ok(agentRan(id), `an ordinary lead's reply goes to the reply agent: ${J(logs)}`);
});

test("a message already filed never moves — even when another lead's backfill holds it", { skip }, async () => {
  const jeff = seedJeffrey();
  const reply = { id: 888, email_subject: "Re: x", subject: "Re: x", html_body: "<p>x</p>", text_body: "x", from_name: "Bo", from_email_address: "bo@example.com", to: [{ address: "nicole.c@brokerstaffer.com" }], date_received: "2026-10-29T15:05:00.000Z" };
  conversation = { older_messages: [{ id: 2552250, from_email_address: "jeff@firstsourcecare.com", subject: "Re: Jeffrey?", html_body: "<p>hi</p>", text_body: "hi", date_received: "2026-10-29T00:11:00.000Z" }], current_reply: reply, newer_messages: [] };
  leadSent = [];
  await handle!(envelope(reply, { id: 5151, email: "bo@example.com", first_name: "Bo" }, { id: 6, name: "Another" }));
  const own = () => db.rows("threads").find((t) => t.emailbison_thread_id === "eb:lead:5151:campaign:6");
  await settle(() => ebCalls.some((c) => c.includes("/conversation-thread")) && ebCalls.some((c) => c.includes("/sent-emails")));
  assert.equal(where("eb:reply:2552250"), jeff, "Jeffrey's reply stays in Jeffrey's conversation");
  assert.equal(where("eb:reply:888"), own()!.id, "Bo's reply in Bo's own conversation");
});

const J = JSON.stringify;
test("nothing left the process but the fakes", { skip }, () => {
  assert.deepEqual(db.blocked, []);
  globalThis.fetch = realFetch;
});
