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

const INTRO = { id: 2552502, from_email_address: "nicole.c@brokerstaffer.com", from_name: "Nicole Collins", subject: "Intro: Jeffrey & Rise Real Estate Tujunga", html_body: "<div>Hey Jeffrey,</div>", text_body: "Hey Jeffrey,", to: [{ address: "jeff@firstsourcecare.com" }], cc: [{ address: "SergeiHovsepyan@outlook.com" }], date_received: "2026-10-29T13:10:56.000Z" };
const SERGEI = { id: 2553538, email_subject: "Re: Intro: Jeffrey & Rise Real Estate Tujunga", subject: "Re: Intro: Jeffrey & Rise Real Estate Tujunga", html_body: "<p>Hello Jeffrey, pleasure to meet you!</p>", text_body: "Hello Jeffrey, pleasure to meet you!", from_name: "Sergei Hovsepyan", from_email_address: "SergeiHovsepyan@outlook.com", to: [{ address: "nicole.c@brokerstaffer.com" }, { address: "jeff@firstsourcecare.com" }], date_received: "2026-10-29T14:59:06.000Z" };
const envelope = (reply: Record<string, unknown>, lead: Record<string, unknown>, campaign: Record<string, unknown>) => ({
  event: { type: "LEAD_REPLIED", name: "Lead replied", workspace_id: 7, workspace_name: "BrokerStaffer" },
  data: { lead, campaign, sender_email: { id: 7, email: "nicole.c@brokerstaffer.com", name: "Nicole Collins" }, reply },
});

function seedJeffrey() {
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
    { workspace_id: WS, thread_id: thread.id, direction: "inbound", external_message_id: "eb:reply:2552250", sender: "jeff@firstsourcecare.com", sent_at: "2026-10-29T00:11:00.000Z" },
    { workspace_id: WS, thread_id: thread.id, direction: "outbound", external_message_id: "eb:reply:2552502", emailbison_reply_id: "2552502", sender: "nicole.c@brokerstaffer.com", subject: INTRO.subject, sent_at: "2026-10-29T13:10:56.000Z" },
  ]);
  // Sergei is on Rise Tujunga's Team list (as he is on the portal).
  db.seed("client_team_members", [{ client_id: "client-rise", name: "Sergei Hovsepyan", email: "SergeiHovsepyan@outlook.com", active: true }]);
  ebCalls.length = 0;
  infos.length = 0;
  logs.length = 0;
  return thread.id as string;
}

test("Sergei's reply to the introduction is filed with it — Jeffrey's conversation keeps the introduction, no Rafeh conversation is left", { skip }, async () => {
  const jeff = seedJeffrey();
  conversation = { older_messages: [INTRO], current_reply: SERGEI, newer_messages: [] };
  leadSent = [{ id: 501, campaign_id: 264, sent_at: "2026-09-18T18:34:00.000Z", email_subject: "Confidential conversation?", email_body: "<p>Rafeh outreach</p>", sender_email: { email: "nicole@howerealtyteam.com" } }];
  const r = await handle!(envelope(SERGEI, { id: 125733, email: "sergeihovsepyan@outlook.com", first_name: "Sergei", last_name: "Hovsepyan" }, { id: 264, name: "The Rafeh Group 1 + Santa Clarita & Antelope Valley + ZF NS1 (PST)" }));
  assert.deepEqual(r, { ok: true });
  const where = (ext: string) => db.rows("messages").find((m) => m.external_message_id === ext)?.thread_id;
  await settle(() => where("eb:reply:2553538") === jeff && !db.rows("threads").some((t) => t.emailbison_thread_id === "eb:lead:125733:campaign:264"));

  assert.equal(where("eb:reply:2553538"), jeff, "Sergei's reply is in Jeffrey's conversation");
  assert.equal(where("eb:reply:2552502"), jeff, "the introduction stays where it was sent from");
  assert.equal(db.rows("threads").filter((t) => t.emailbison_thread_id === "eb:lead:125733:campaign:264").length, 0, "the Rafeh conversation the webhook made is removed (it is empty)");
  assert.ok(!ebCalls.some((c) => c.includes("/leads/125733/sent-emails")), "Rafeh's campaign emails to Sergei are not pulled into Jeffrey's conversation");
  assert.ok(!db.rows("messages").some((m) => m.external_message_id === "eb:sched:501"), J(ebCalls));
  const t = db.rows("threads").find((x) => x.id === jeff)!;
  assert.equal(t.needs_reply, true, "Jeffrey's conversation shows the new reply");
  assert.equal(t.last_message_at, "2026-10-29T14:59:06.000Z");
});

test("an ordinary reply is filed as before: its own conversation, with its campaign's emails", { skip }, async () => {
  seedJeffrey();
  const reply = { id: 777, email_subject: "Re: Hi", subject: "Re: Hi", html_body: "<p>Sure</p>", text_body: "Sure", from_name: "Ana", from_email_address: "ana@example.com", to: [{ address: "nicole.c@brokerstaffer.com" }], date_received: "2026-10-29T15:00:00.000Z" };
  conversation = { older_messages: [], current_reply: reply, newer_messages: [] };
  leadSent = [{ id: 900, campaign_id: 5, sent_at: "2026-10-28T10:00:00.000Z", email_subject: "Hi", email_body: "<p>Hi Ana</p>", sender_email: { email: "nicole.c@brokerstaffer.com" } }];
  await handle!(envelope(reply, { id: 4242, email: "ana@example.com", first_name: "Ana" }, { id: 5, name: "Some Campaign" }));
  const own = () => db.rows("threads").find((t) => t.emailbison_thread_id === "eb:lead:4242:campaign:5");
  await settle(() => !!own() && db.rows("messages").some((m) => m.external_message_id === "eb:sched:900"));
  const id = own()!.id;
  assert.equal(db.rows("messages").find((m) => m.external_message_id === "eb:reply:777")?.thread_id, id);
  assert.equal(db.rows("messages").find((m) => m.external_message_id === "eb:sched:900")?.thread_id, id, "its campaign's email is in its conversation");
  // "[agents] thread <id>: …" in the OS, "[agent] thread <id> -> …" in the standalone app.
  const ran = () => logs.some((l) => l.startsWith(`[agents] thread ${id}`) || l.startsWith(`[agent] thread ${id}`));
  await settle(ran);
  assert.ok(ran(), `an ordinary lead's reply goes to the reply agent: ${J(logs)}`);
});

test("a message already filed never moves — even when another lead's backfill holds it (and someone else's message anchors nothing)", { skip }, async () => {
  const jeff = seedJeffrey();
  // Another lead's conversation that also holds Jeffrey's own (inbound) reply: not ours — no move, and it stays put.
  const reply = { id: 888, email_subject: "Re: x", subject: "Re: x", html_body: "<p>x</p>", text_body: "x", from_name: "Bo", from_email_address: "bo@example.com", to: [{ address: "nicole.c@brokerstaffer.com" }], date_received: "2026-10-29T15:05:00.000Z" };
  conversation = { older_messages: [{ id: 2552250, from_email_address: "jeff@firstsourcecare.com", subject: "Re: Jeffrey?", html_body: "<p>hi</p>", text_body: "hi", date_received: "2026-10-29T00:11:00.000Z" }], current_reply: reply, newer_messages: [] };
  leadSent = [];
  await handle!(envelope(reply, { id: 5151, email: "bo@example.com", first_name: "Bo" }, { id: 6, name: "Another" }));
  const own = () => db.rows("threads").find((t) => t.emailbison_thread_id === "eb:lead:5151:campaign:6");
  await settle(() => ebCalls.some((c) => c.includes("/conversation-thread")) && ebCalls.some((c) => c.includes("/sent-emails")));
  assert.equal(db.rows("messages").find((m) => m.external_message_id === "eb:reply:2552250")?.thread_id, jeff, "Jeffrey's reply stays in Jeffrey's conversation");
  assert.equal(db.rows("messages").find((m) => m.external_message_id === "eb:reply:888")?.thread_id, own()!.id, "Bo's reply in Bo's own conversation");
});

test("Sergei's reply (a client's own team member): not handled as a lead — no labelling, no reply agent", { skip }, async () => {
  const jeff = seedJeffrey();
  conversation = { older_messages: [INTRO], current_reply: SERGEI, newer_messages: [] };
  leadSent = [];
  await handle!(envelope(SERGEI, { id: 125733, email: "sergeihovsepyan@outlook.com", first_name: "Sergei" }, { id: 264, name: "The Rafeh Group 1 + Santa Clarita & Antelope Valley + ZF NS1 (PST)" }));
  await settle(() => infos.some((l) => l.includes("not handled as a lead")));
  assert.ok(infos.some((l) => l.includes("not handled as a lead") && l.includes(jeff) && l.includes("client-rise")), J(infos));
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(!logs.some((l) => /^\[agents?\] thread/.test(l)), `the reply agent never ran (the ordinary reply's test shows it does): ${J(logs)}`);
});

test("a FRESH email from Sergei (not a reply) under Rafeh's campaign: tagged Rise Tujunga — his own client — and not handled as a lead", { skip }, async () => {
  seedJeffrey();
  const fresh = { ...SERGEI, id: 2560000, email_subject: "Quick question", subject: "Quick question", html_body: "<p>Can we talk?</p>", text_body: "Can we talk?" };
  conversation = { older_messages: [], current_reply: fresh, newer_messages: [] };
  leadSent = [{ id: 501, campaign_id: 264, sent_at: "2026-09-18T18:34:00.000Z", email_subject: "Confidential conversation?", email_body: "<p>Rafeh outreach</p>", sender_email: { email: "nicole@howerealtyteam.com" } }];
  await handle!(envelope(fresh, { id: 125733, email: "sergeihovsepyan@outlook.com", first_name: "Sergei" }, { id: 264, name: "The Rafeh Group 1 + Santa Clarita & Antelope Valley + ZF NS1 (PST)" }));
  const t = () => db.rows("threads").find((x) => x.emailbison_thread_id === "eb:lead:125733:campaign:264");
  await settle(() => infos.some((l) => l.includes("not handled as a lead")));
  assert.equal(t()?.client_id, "client-rise", "his own client, never The Rafeh Group");
  assert.equal(db.rows("messages").find((m) => m.external_message_id === "eb:reply:2560000")?.thread_id, t()!.id);
  assert.ok(!ebCalls.some((c) => c.includes("/sent-emails")) && !db.rows("messages").some((m) => m.external_message_id === "eb:sched:501"), "Rafeh's campaign emails to him are not pulled in");
});

test("someone on two clients' teams is not guessed: the campaign tags the conversation, as before", { skip }, async () => {
  seedJeffrey();
  db.seed("client_team_members", [
    { client_id: "client-rise", email: "both@example.com", name: "Both" },
    { client_id: "client-rafeh", email: "both@example.com", name: "Both" },
  ]);
  const reply = { id: 2570000, email_subject: "Re: hi", subject: "Re: hi", html_body: "<p>hi</p>", text_body: "hi", from_name: "Both", from_email_address: "both@example.com", to: [{ address: "nicole.c@brokerstaffer.com" }], date_received: "2026-10-29T16:00:00.000Z" };
  conversation = { older_messages: [], current_reply: reply, newer_messages: [] };
  leadSent = [];
  await handle!(envelope(reply, { id: 9191, email: "both@example.com", first_name: "Both" }, { id: 264, name: "The Rafeh Group 1 + Santa Clarita & Antelope Valley + ZF NS1 (PST)" }));
  const t = () => db.rows("threads").find((x) => x.emailbison_thread_id === "eb:lead:9191:campaign:264");
  await settle(() => !!t() && ebCalls.some((c) => c.includes("/sent-emails")));
  assert.notEqual(t()?.client_id, "client-rise");
  assert.ok(!infos.some((l) => l.includes("not handled as a lead")), "handled as a lead, as before");
});

const J = JSON.stringify;
test("nothing left the process but the fakes", { skip }, () => {
  assert.deepEqual(db.blocked, []);
  globalThis.fetch = realFetch;
});
