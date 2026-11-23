/*
 * Replies from Tickets (24 Nov 2026, the user): anyone with the Tickets page replies "as the one who got email" — only
 * Amy's and Eddy's inboxes send. Built on real conversations (the fake Gmail + the sync), sent through the same code
 * the OS runs, then synced again to prove the reply is recorded once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildClientIndex } from "./client-match.ts";
import { FakeGmail } from "./fake-gmail.ts";
import { GmailAuthError, GmailError } from "./gmail-api.ts";
import { MemoryTicketStore } from "./memory-store.ts";
import { _forgetNonces, planReply, sendReply, type ReplyData, type SendClaims, type SendDeps, type SendState } from "./reply.ts";
import { GMAIL_SEND_SCOPE } from "./senders.ts";
import type { MailboxRow } from "./store.ts";
import { syncMailbox, type SyncDeps } from "./sync.ts";

const NOW = Date.now();
const H = 3_600_000;
const AMY = "amy@brokerstaffer.com";
const EDDY = "eddy@brokerstaffer.com";
const GABE = "gabo075823532@gmail.com";
const CAN_SEND = `https://www.googleapis.com/auth/gmail.readonly ${GMAIL_SEND_SCOPE} openid email profile`;

const index = buildClientIndex([
  { id: "jcre", name: "Jeff Cook Real Estate", status: "active", internal: false, emails: ["alma@jeffcookrealestate.com", "jeff@jeffcookrealestate.com"] },
]);
/** os_ticket_sends in memory: survives a "restart" (a new process forgets its in-flight sends, not the claims). */
class MemoryClaims implements SendClaims {
  rows = new Map<string, { state: SendState; gmailId: string | null }>();
  async claim(c: { nonce: string }) {
    const had = this.rows.get(c.nonce);
    if (!had) { this.rows.set(c.nonce, { state: "sending", gmailId: null }); return { claimed: true as const }; }
    if (had.state === "refused") { had.state = "sending"; return { claimed: true as const }; }
    return { claimed: false as const, state: had.state, gmailId: had.gmailId };
  }
  async finish(nonce: string, state: Exclude<SendState, "sending">, gmailId?: string | null) {
    const r = this.rows.get(nonce);
    if (r) { r.state = state; if (gmailId) r.gmailId = gmailId; }
  }
}

const NAMES = new Map([[AMY, "Amy Anderes-Damron"], [EDDY, "Eddy Boccara"], [GABE, "Gabriel Castillo"]]);

function setup(o: { amyScope?: string; eddyScope?: string; gabe?: boolean } = {}) {
  _forgetNonces();
  const store = new MemoryTicketStore();
  store.addMailbox(AMY, { name: "Amy Anderes-Damron", scope: o.amyScope ?? CAN_SEND, state: "ok" });
  store.addMailbox(EDDY, { name: "Eddy Boccara", scope: o.eddyScope ?? CAN_SEND, state: "ok" });
  if (o.gabe) store.addMailbox(GABE, { name: "Gabriel Castillo", scope: CAN_SEND, state: "ok" });
  const gmails = new Map([[AMY, new FakeGmail(AMY)], [EDDY, new FakeGmail(EDDY)], [GABE, new FakeGmail(GABE)]]);
  gmails.get(AMY)!.sendAsList = [{ sendAsEmail: AMY, displayName: "Amy Anderes-Damron", signature: "<div>Amy Anderes-Damron<br>Account Manager, BrokerStaffer</div>", isPrimary: true }];
  const syncDeps = (mb: string): SyncDeps => ({ store, gmail: gmails.get(mb)!, index, team: new Set([AMY, EDDY, GABE]), names: NAMES, now: () => NOW });
  const sync = async (mb: string) => {
    const row = store.mailboxes.get(mb)!;
    const r = await syncMailbox(syncDeps(mb), row);
    Object.assign(row, { history_id: r.historyId, backfill_done_at: row.backfill_done_at ?? new Date(NOW).toISOString(), last_ok_at: new Date(NOW).toISOString() });
    return r;
  };
  const logs: Array<Record<string, unknown>> = [];
  const claims = new MemoryClaims();
  const deps: SendDeps = { store, gmail: (mb: MailboxRow) => gmails.get(mb.email) ?? null, claims, now: () => NOW, log: (l) => logs.push(l) };
  const data = async (): Promise<ReplyData> => {
    const ticket = [...store.tickets.values()][0];
    return {
      ticket: (await store.getTicket(ticket.id))!,
      messages: [...store.messages.values()].filter((m) => m.ticket_id === ticket.id).sort((a, b) => a.sent_at.localeCompare(b.sent_at)),
      copies: [...store.copies.values()].filter((c) => c.ticket_id === ticket.id),
      mailboxes: [...store.mailboxes.values()],
      names: NAMES,
    };
  };
  /** The client's email the box shows (what the screen sends back with a reply). */
  const replyTo = async () => planReply(await data()).replyToId;
  return { store, amy: gmails.get(AMY)!, eddy: gmails.get(EDDY)!, gabe: gmails.get(GABE)!, sync, deps, data, logs, claims, replyTo };
}

const ALMA = { from: "Alma Nowatzke <alma@jeffcookrealestate.com>", subject: "Can you add Jeff to the invite?", messageId: "alma-1@jcre", date: NOW - 2 * H, text: "Hey! Jeff wasn't on the invite.\nCan you add him?" };

test("Amy got it, Eddy replies as Amy: from Amy's Gmail, to Alma, in Amy's thread, Re: subject, signed, quoted", async () => {
  const s = setup();
  s.amy.deliver({ ...ALMA, to: [AMY] });
  await s.sync(AMY);
  const plan = planReply(await s.data());
  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.senders.map((x) => [x.email, x.ready]), [[AMY, true]], "only the inbox that got it");
  assert.deepEqual(plan.to, { email: "alma@jeffcookrealestate.com", name: "Alma Nowatzke" });
  assert.equal(plan.subject, "Re: Can you add Jeff to the invite?");

  const r = await sendReply(s.deps, await s.data(), { replyTo: await s.replyTo(), from: AMY, text: "Done, Jeff is on it now.\n\nSee you at 2:30!", cc: [], nonce: "nonce-aaaa-1" }, EDDY);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(s.amy.sent.length, 1, "one email");
  assert.equal(s.eddy.sent.length, 0, "never from Eddy's inbox: Alma wrote to Amy");
  const raw = s.amy.sent[0].decoded;
  assert.match(raw, /^From: "Amy Anderes-Damron" <amy@brokerstaffer\.com>$/m);
  assert.match(raw, /^To: "Alma Nowatzke" <alma@jeffcookrealestate\.com>$/m);
  assert.match(raw, /^Subject: Re: Can you add Jeff to the invite\?$/m);
  assert.match(raw, /^In-Reply-To: <alma-1@jcre>$/m);
  assert.match(raw, /^References: <alma-1@jcre>$/m);
  assert.doesNotMatch(raw, /^(Bcc|Cc):/m);
  const amyThread = [...s.store.copies.values()].find((c) => c.mailbox === AMY)!.gmail_thread_id;
  assert.equal(s.amy.sent[0].threadId, amyThread, "into Amy's own Gmail conversation");
  const text = Buffer.from(raw.split("Content-Type: text/plain")[1].split("\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.match(text, /^Done, Jeff is on it now\.\n\nSee you at 2:30!\n\nAmy Anderes-Damron\nAccount Manager, BrokerStaffer\n\nOn .+, Alma Nowatzke <alma@jeffcookrealestate\.com> wrote:\n\n> Hey! Jeff wasn't on the invite\.\n> Can you add him\?$/);

  // Recorded with the ticket: its text and who pressed Send. The ticket waits on the client.
  const out = [...s.store.messages.values()].find((m) => m.direction === "out")!;
  assert.deepEqual([out.from_email, out.sent_by, out.body_text, out.to_list.map((a) => a.email)], [AMY, EDDY, "Done, Jeff is on it now.\n\nSee you at 2:30!", ["alma@jeffcookrealestate.com"]]);
  assert.match(out.rfc_id, /^sent-\d+-amy@mail\.gmail\.com$/, "the Message-ID Gmail gave it");
  const t = (await s.data()).ticket;
  assert.equal(t.status, "waiting");
  assert.ok(t.first_response_at);
  assert.ok([...s.store.events.values()].some((e) => e.body === "Eddy replied as Amy from Tickets"));
  assert.deepEqual(s.logs.filter((l) => l.at === "[tickets] reply sent").map((l) => [l.as, l.by, l.to]), [[AMY, EDDY, "alma@jeffcookrealestate.com"]]);

  // Amy's next sync finds it in her Sent mail: noted as the copy it is, never a second message.
  await s.sync(AMY);
  assert.equal([...s.store.messages.values()].filter((m) => m.direction === "out").length, 1);
  assert.equal((await s.data()).ticket.message_count, 2);
});

test("Alma wrote To Amy and Cc'd Eddy: Amy answers by default, Eddy can be picked; Cc offers the others, never the sender", async () => {
  const s = setup();
  const mail = { ...ALMA, to: [AMY], cc: [EDDY, "jeff@jeffcookrealestate.com"] };
  s.amy.deliver(mail);
  s.eddy.deliver(mail);
  await s.sync(AMY);
  await s.sync(EDDY);
  const plan = planReply(await s.data());
  assert.deepEqual(plan.senders.map((x) => x.email), [AMY, EDDY], "the To first");
  assert.equal(plan.defaultSender, AMY);
  assert.deepEqual(plan.cc.map((a) => a.email).sort(), [AMY, EDDY, "jeff@jeffcookrealestate.com"].sort());

  const r = await sendReply(s.deps, await s.data(), { replyTo: await s.replyTo(), from: EDDY, text: "On it.", cc: [AMY, EDDY, "jeff@jeffcookrealestate.com"], nonce: "nonce-bbbb-1" }, GABE);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(s.eddy.sent.length, 1);
  const raw = s.eddy.sent[0].decoded;
  assert.match(raw, /^From: "Eddy Boccara" <eddy@brokerstaffer\.com>$/m);
  const cc = /^Cc: (.*)$/m.exec(raw)?.[1] ?? "";
  assert.ok(cc.includes(AMY) && cc.includes("jeff@jeffcookrealestate.com"), cc);
  assert.ok(!cc.includes(EDDY), "the sending inbox isn't copied to itself");
  assert.ok([...s.store.events.values()].some((e) => e.body === "Gabriel replied as Eddy from Tickets"), "Gabriel can reply too (the user, 24 Nov)");
});

test("an email that came only to Gabriel's inbox can't be answered from Tickets: he answers in Gmail; nothing is sent", async () => {
  const s = setup({ gabe: true });
  s.gabe.deliver({ ...ALMA, to: [GABE] });
  await s.sync(GABE);
  const plan = planReply(await s.data());
  assert.match(plan.blocked ?? "", /came to Gabriel\. Replies from Tickets go only from Amy's or Eddy's inbox, so Gabriel answers in Gmail/);
  const r = await sendReply(s.deps, await s.data(), { replyTo: await s.replyTo(), from: GABE, text: "Hi", cc: [], nonce: "nonce-cccc-1" }, GABE);
  assert.equal(r.ok, false);
  const r2 = await sendReply(s.deps, await s.data(), { replyTo: await s.replyTo(), from: AMY, text: "Hi", cc: [], nonce: "nonce-cccc-2" }, EDDY);
  assert.equal(r2.ok, false, "and not from an inbox that never got it");
  assert.deepEqual([s.gabe.sent.length, s.amy.sent.length, s.eddy.sent.length], [0, 0, 0]);
});

test("Amy connected before sending was allowed: the box says she reconnects once; nothing is sent until she does", async () => {
  const s = setup({ amyScope: "https://www.googleapis.com/auth/gmail.readonly openid email profile" });
  s.amy.deliver({ ...ALMA, to: [AMY] });
  await s.sync(AMY);
  const plan = planReply(await s.data());
  assert.equal(plan.senders[0].ready, false);
  assert.match(plan.senders[0].why ?? "", /Amy reconnects their inbox once, on Connected inboxes, to allow replies from Tickets/);
  const r = await sendReply(s.deps, await s.data(), { replyTo: await s.replyTo(), from: AMY, text: "Hi", cc: [], nonce: "nonce-dddd-1" }, EDDY);
  assert.deepEqual([r.ok, (r as { code?: string }).code], [false, "not-ready"]);
  assert.equal(s.amy.sent.length, 0);
  s.store.mailboxes.get(AMY)!.state = "reconnect";
  assert.match(planReply(await s.data()).senders[0].why ?? "", /Google stopped Tickets using Amy's inbox/);
});

test("never twice: the same draft sent again (a double click, a lost answer) gets the first answer, one email", async () => {
  const s = setup();
  s.amy.deliver({ ...ALMA, to: [AMY] });
  await s.sync(AMY);
  const input = { from: AMY, text: "Yes!", cc: [], nonce: "nonce-eeee-1", replyTo: await s.replyTo() };
  const [a, b] = await Promise.all([sendReply(s.deps, await s.data(), input, EDDY), sendReply(s.deps, await s.data(), input, EDDY)]);
  const c = await sendReply(s.deps, await s.data(), input, EDDY);
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(s.amy.sent.length, 1);
  // A refusal before Gmail (nothing written) isn't remembered: fixed and sent with the same draft, it goes.
  const empty = await sendReply(s.deps, await s.data(), { ...input, text: "  ", nonce: "nonce-eeee-2" }, EDDY);
  assert.equal(empty.ok, false);
  const fixed = await sendReply(s.deps, await s.data(), { ...input, text: "Fixed", nonce: "nonce-eeee-2" }, EDDY);
  assert.ok(fixed.ok);
  assert.equal(s.amy.sent.length, 2);
});

test("Gmail doesn't confirm (timeout, 5xx): 'look in the Sent folder', never 'failed'; the same draft never sends again", async () => {
  const s = setup();
  s.amy.deliver({ ...ALMA, to: [AMY] });
  await s.sync(AMY);
  s.amy.sendFails = new GmailError("Gmail 503 on /messages/send: backend error", 503);
  const input = { from: AMY, text: "Hello", cc: [], nonce: "nonce-ffff-1", replyTo: await s.replyTo() };
  const r = await sendReply(s.deps, await s.data(), input, EDDY);
  assert.deepEqual([r.ok, (r as { code?: string }).code], [false, "unsure"]);
  assert.match((r as { error: string }).error, /Look in Amy's Sent folder before sending it again/);
  s.amy.sendFails = null;
  const again = await sendReply(s.deps, await s.data(), input, EDDY);
  assert.deepEqual([again.ok, (again as { code?: string }).code], [false, "unsure"], "the same draft gets the same answer");
  assert.equal(s.amy.calls.filter((c) => c.startsWith("send ")).length, 1, "Gmail was asked to send once");
  assert.equal([...s.store.messages.values()].filter((m) => m.direction === "out").length, 0);
});

test("Gmail refusals say nothing was sent and keep the ticket as it was", async () => {
  for (const [err, re] of [
    [new GmailError("Gmail 403 on /messages/send: Request had insufficient authentication scopes.", 403), /isn't allowed to send yet, so nothing was sent/],
    [new GmailError("Gmail 429 on /messages/send: rate", 429), /Gmail is busy right now, so nothing was sent/],
    [new GmailAuthError("invalid_grant", true), /Google stopped Tickets using Amy's inbox, so nothing was sent/],
    [new GmailError("Gmail 404 on /messages/send: Requested entity was not found.", 404), /couldn't find this conversation in Amy's inbox .*so nothing was sent/],
    [new GmailError("Gmail 400 on /messages/send: Invalid To header", 400), /Gmail refused this email, so nothing was sent \(400\)/],
  ] as const) {
    const s = setup();
    s.amy.deliver({ ...ALMA, to: [AMY] });
    await s.sync(AMY);
    s.amy.sendFails = err;
    const before = (await s.data()).ticket;
    const r = await sendReply(s.deps, await s.data(), { replyTo: await s.replyTo(), from: AMY, text: "Hello", cc: [], nonce: "nonce-gggg-1" }, EDDY);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, re);
    assert.deepEqual([(await s.data()).ticket.status, (await s.data()).ticket.message_count], [before.status, before.message_count]);
  }
});

test("the screen can't widen who it goes to: Cc only from the client's own email; the To is the server's", async () => {
  const s = setup();
  s.amy.deliver({ ...ALMA, to: [AMY], cc: ["jeff@jeffcookrealestate.com"] });
  await s.sync(AMY);
  const r = await sendReply(s.deps, await s.data(), { replyTo: await s.replyTo(), from: AMY, text: "Hi", cc: ["someone@else.com"], nonce: "nonce-hhhh-1" }, EDDY);
  assert.deepEqual([r.ok, (r as { error?: string }).error], [false, "Only people already on the client's email can be copied in."]);
  const bad = await sendReply(s.deps, await s.data(), { replyTo: await s.replyTo(), from: AMY, text: "Hi", cc: [], nonce: "bad" }, EDDY);
  assert.equal(bad.ok, false, "a nonce is required");
  const long = await sendReply(s.deps, await s.data(), { replyTo: await s.replyTo(), from: AMY, text: "x".repeat(10_001), cc: [], nonce: "nonce-hhhh-2" }, EDDY);
  assert.equal(long.ok, false);
  assert.equal(s.amy.sent.length, 0);
});

test("sent, but recording it failed: still 'sent' (a second press would send it twice)", async () => {
  const s = setup();
  s.amy.deliver({ ...ALMA, to: [AMY] });
  await s.sync(AMY);
  s.store.insertMessage = async () => { throw new Error("database unreachable"); };
  const r = await sendReply(s.deps, await s.data(), { replyTo: await s.replyTo(), from: AMY, text: "Hi", cc: [], nonce: "nonce-iiii-1" }, EDDY);
  assert.ok(r.ok);
  assert.match((r as { note?: string }).note ?? "", /may take a minute to show/);
  assert.equal(s.amy.sent.length, 1);
});

test("Amy replies herself: 'Amy replied from Tickets', no 'as'", async () => {
  const s = setup();
  s.amy.deliver({ ...ALMA, to: [AMY] });
  await s.sync(AMY);
  const r = await sendReply(s.deps, await s.data(), { replyTo: await s.replyTo(), from: AMY, text: "Hi Alma", cc: [], nonce: "nonce-jjjj-1" }, AMY);
  assert.ok(r.ok);
  assert.ok([...s.store.events.values()].some((e) => e.body === "Amy replied from Tickets"));
});

test("no client email in the ticket: nothing to reply to", () => {
  const plan = planReply({ ticket: { id: "t", subject: "x" } as never, messages: [], copies: [], mailboxes: [], names: NAMES });
  assert.match(plan.blocked ?? "", /no email from the client/);
});

test("Google: sending is asked for only when Amy or Eddy connects; any other extra permission is still refused", async () => {
  const { consentUrl, scopeBeyondReadOnly } = await import("./gmail-api.ts");
  const { canSendFrom } = await import("./senders.ts");
  const cfg = { clientId: "id", clientSecret: "s", redirectUri: "https://os.example/cb" };
  const scopes = (u: string) => new URL(u).searchParams.get("scope")!.split(" ");
  assert.ok(!scopes(consentUrl(cfg, "st")).includes(GMAIL_SEND_SCOPE), "read-only by default");
  assert.ok(scopes(consentUrl(cfg, "st", AMY, { send: true })).includes(GMAIL_SEND_SCOPE));
  assert.ok(!new URL(consentUrl(cfg, "st", AMY, { send: true })).searchParams.has("include_granted_scopes"));
  assert.deepEqual([canSendFrom(AMY), canSendFrom("EDDY@brokerstaffer.com "), canSendFrom(GABE), canSendFrom("admin@outreachify.io")], [true, true, false, false]);
  assert.deepEqual(scopeBeyondReadOnly(CAN_SEND), [], "send is allowed to exist");
  assert.deepEqual(scopeBeyondReadOnly(`${CAN_SEND} https://www.googleapis.com/auth/gmail.modify`), ["https://www.googleapis.com/auth/gmail.modify"]);
  const { readFileSync } = await import("node:fs");
  const start = readFileSync("src/app/api/tools/tickets/google/start/route.ts", "utf8");
  const cb = readFileSync("src/app/api/tools/tickets/google/callback/route.ts", "utf8");
  assert.match(start, /consentUrl\(cfg, state, viewer\.email, \{ send: canSendFrom\(viewer\.email\) \}\)/);
  assert.match(cb, /if \(scopeCanSend\(t\.scope\) && !canSendFrom\(t\.email\)\) \{\s*await revokeToken\(t\.refreshToken\);/);
});


/* ------------------------------------------------------------------- review fixes (24 Nov) --- */

test("a newer client email came in while the reply was written: nothing is sent; the next send answers the new one", async () => {
  const s = setup();
  s.amy.deliver({ ...ALMA, to: [AMY] });
  await s.sync(AMY);
  const shown = await s.replyTo();
  s.amy.deliver({ from: "Jeff Cook <jeff@jeffcookrealestate.com>", to: [AMY], subject: "Re: Can you add Jeff to the invite?", messageId: "jeff-2@jcre", inReplyTo: "alma-1@jcre", references: ["alma-1@jcre"], date: NOW - H, text: "Never mind, I'm on it now." });
  await s.sync(AMY);
  const r = await sendReply(s.deps, await s.data(), { from: AMY, text: "Done!", cc: [], nonce: "nonce-stale-1", replyTo: shown }, EDDY);
  assert.deepEqual([r.ok, (r as { code?: string }).code, (r as { sent?: unknown }).sent], [false, "stale", false]);
  assert.match((r as { error: string }).error, /A newer email from Jeff Cook came in while you were writing/);
  assert.equal(s.amy.sent.length, 0, "nothing went to anyone");
  const again = await sendReply(s.deps, await s.data(), { from: AMY, text: "Done!", cc: [], nonce: "nonce-stale-1", replyTo: await s.replyTo() }, EDDY);
  assert.ok(again.ok, "the same draft, after a look, goes");
  assert.match(s.amy.sent[0].decoded, /^To: "Jeff Cook" <jeff@jeffcookrealestate\.com>$/m);
  assert.match(s.amy.sent[0].decoded, /^In-Reply-To: <jeff-2@jcre>$/m);
});

test("never twice across a restart: the claim is in the database, not in the server's memory", async () => {
  const s = setup();
  s.amy.deliver({ ...ALMA, to: [AMY] });
  await s.sync(AMY);
  const input = { from: AMY, text: "Hi", cc: [], nonce: "nonce-restart-1", replyTo: await s.replyTo() };
  assert.ok((await sendReply(s.deps, await s.data(), input, EDDY)).ok);
  _forgetNonces(); // a deploy: a new process
  const r = await sendReply(s.deps, await s.data(), input, EDDY);
  assert.ok(r.ok);
  assert.match((r as { note?: string }).note ?? "", /already sent/);
  assert.equal(s.amy.sent.length, 1);
});

test("the server stopped mid-send (claimed, never settled): 'look in the Sent folder', never a second email", async () => {
  const s = setup();
  s.amy.deliver({ ...ALMA, to: [AMY] });
  await s.sync(AMY);
  s.claims.rows.set("nonce-killed-1", { state: "sending", gmailId: null });
  const r = await sendReply(s.deps, await s.data(), { from: AMY, text: "Hi", cc: [], nonce: "nonce-killed-1", replyTo: await s.replyTo() }, EDDY);
  assert.deepEqual([r.ok, (r as { sent?: unknown }).sent], [false, "unknown"]);
  assert.equal(s.amy.calls.filter((c) => c.startsWith("send ")).length, 0);
});

test("Gmail refused (nothing sent): the same draft can be sent again once it's fixed or Gmail is back", async () => {
  const s = setup();
  s.amy.deliver({ ...ALMA, to: [AMY] });
  await s.sync(AMY);
  s.amy.sendFails = new GmailError("Gmail 429 on /messages/send: rate", 429);
  const input = { from: AMY, text: "Hi", cc: [], nonce: "nonce-refused-1", replyTo: await s.replyTo() };
  const a = await sendReply(s.deps, await s.data(), input, EDDY);
  assert.deepEqual([a.ok, (a as { sent?: unknown }).sent], [false, false]);
  s.amy.sendFails = null;
  assert.ok((await sendReply(s.deps, await s.data(), input, EDDY)).ok);
  assert.equal(s.amy.sent.length, 1);
});

test("the sync stored the sent email first (a bare marker): it gets the reply's text and sender; counted once", async () => {
  const s = setup();
  s.amy.deliver({ ...ALMA, to: [AMY] });
  await s.sync(AMY);
  const send = s.amy.send.bind(s.amy);
  s.amy.send = async (raw, threadId) => { const r = await send(raw, threadId); await s.sync(AMY); return r; };
  const r = await sendReply(s.deps, await s.data(), { from: AMY, text: "Added him!", cc: [], nonce: "nonce-race-1", replyTo: await s.replyTo() }, EDDY);
  assert.ok(r.ok);
  const outs = [...s.store.messages.values()].filter((m) => m.direction === "out");
  assert.equal(outs.length, 1);
  assert.deepEqual([outs[0].body_text, outs[0].sent_by, outs[0].to_list.map((a) => a.email)], ["Added him!", EDDY, ["alma@jeffcookrealestate.com"]]);
  const t = (await s.data()).ticket;
  assert.deepEqual([t.message_count, t.status], [2, "waiting"], "the sync counted it; the reply didn't count it again");
});

test("an address a reply can't be written to: the box says reply in Gmail (no error page); such a Cc isn't offered", () => {
  const msg = (from: string, cc: string[] = []) => ({ id: "m1", ticket_id: "t", rfc_id: "x@y", direction: "in" as const, trimmed: false, from_email: from, from_name: null, to_list: [{ email: AMY, name: null }], cc_list: cc.map((email) => ({ email, name: null })), subject: "Hi", snippet: null, body_html: null, body_text: "hi", attachments: [], in_reply_to: null, refs: [], sent_at: new Date(NOW).toISOString() });
  const base = { ticket: { id: "t", subject: "Hi" } as never, copies: [{ mailbox: AMY, gmail_id: "g1", gmail_thread_id: "th1", message_id: "m1", ticket_id: "t", labels: [] }], mailboxes: [], names: NAMES };
  assert.match(planReply({ ...base, messages: [msg("we[ird]@x.com")] }).blocked ?? "", /can't be used for a reply from Tickets\. Reply in Gmail/);
  assert.deepEqual(planReply({ ...base, messages: [msg("ok@x.com", ["bad\\x@y.com", "fine@y.com"])] }).cc.map((a) => a.email), [AMY, "fine@y.com"]);
});
