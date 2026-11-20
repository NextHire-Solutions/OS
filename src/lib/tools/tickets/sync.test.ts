import { test } from "node:test";
import assert from "node:assert/strict";

import { buildClientIndex } from "./client-match.ts";
import { FakeGmail } from "./fake-gmail.ts";
import { MemoryTicketStore } from "./memory-store.ts";
import { cleanSubject, syncMailbox, type SyncDeps } from "./sync.ts";

const NOW = Date.now();
const H = 3_600_000;
const D = 24 * H;
const EDDY = "eddy@brokerstaffer.com";
const AMY = "amy@brokerstaffer.com";

const index = buildClientIndex([
  { id: "homebase", name: "Homebase", status: "active", internal: false, emails: ["john@myrehomebase.com", "owner@gmail.com"] },
  { id: "toll", name: "The Toll Group", status: "active", internal: false, emails: ["ann@tollrealtygroup.com"] },
]);

function setup() {
  const store = new MemoryTicketStore();
  store.addMailbox(EDDY, { name: "Eddy Boccara" });
  store.addMailbox(AMY, { name: "Amy Anderes" });
  const gmails = new Map([[EDDY, new FakeGmail(EDDY)], [AMY, new FakeGmail(AMY)]]);
  const names = new Map([[EDDY, "Eddy Boccara"], [AMY, "Amy Anderes"]]);
  const deps = (mb: string): SyncDeps => ({ store, gmail: gmails.get(mb)!, index, team: new Set([EDDY, AMY, "gabo@gmail.com"]), names, now: () => NOW });
  /** Sync a mailbox the way the runner does: store the history id and fill time it returns. */
  const sync = async (mb: string) => {
    const row = store.mailboxes.get(mb)!;
    const r = await syncMailbox(deps(mb), row);
    Object.assign(row, { history_id: r.historyId, backfill_done_at: row.backfill_done_at ?? new Date(NOW).toISOString(), last_ok_at: new Date(NOW).toISOString() });
    return r;
  };
  return { store, eddy: gmails.get(EDDY)!, amy: gmails.get(AMY)!, sync };
}

const tickets = (s: MemoryTicketStore) => [...s.tickets.values()];
const msgsOf = (s: MemoryTicketStore, id: string) => [...s.messages.values()].filter((m) => m.ticket_id === id).sort((a, b) => a.sent_at.localeCompare(b.sent_at));

test("first fill: a client's conversation becomes one ticket with the team's reply; nothing else is stored", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "John <john@myrehomebase.com>", subject: "Invoice question", messageId: "c1@hb", date: NOW - 2 * D, html: "<p>Hi Eddy</p>" });
  eddy.deliver({ from: `Eddy <${EDDY}>`, to: ["john@myrehomebase.com"], subject: "Re: Invoice question", messageId: "e1@bs", inReplyTo: "c1@hb", date: NOW - 2 * D + H, text: "Looking" });
  eddy.deliver({ from: "Mom <mom@gmail.com>", subject: "Dinner", messageId: "p1@x", date: NOW - D });
  eddy.deliver({ from: "Newsletter <news@myrehomebase.com>", subject: "Weekly", messageId: "n1@hb", date: NOW - D, autoSubmitted: "auto-generated" });
  eddy.deliver({ from: "Vendor <sales@vendor.com>", to: [EDDY], cc: ["john@myrehomebase.com"], subject: "Offer", messageId: "v1@v", date: NOW - D });

  const r = await sync(EDDY);
  assert.equal(r.mode, "fill");
  const all = tickets(store);
  assert.equal(all.length, 1, "only the client's conversation");
  const t = all[0];
  assert.equal(t.os_client_id, "homebase");
  assert.equal(t.match_method, "address");
  assert.equal(t.subject, "Invoice question");
  assert.equal(t.status, "waiting", "our reply was last");
  assert.equal(t.message_count, 2);
  assert.deepEqual(msgsOf(store, t.id).map((m) => [m.direction, m.rfc_id]), [["in", "c1@hb"], ["out", "e1@bs"]]);
  assert.equal(store.messages.size, 2, "the personal mail, the newsletter and the vendor's Cc are never stored");
  const reply = msgsOf(store, t.id)[1];
  assert.deepEqual([reply.subject, reply.body_html, reply.body_text, reply.snippet, reply.to_list, reply.attachments], [null, null, null, null, [], []], "our reply is only a dated marker: no subject, text or recipients");
  assert.equal(reply.from_name, "Eddy Boccara");
  assert.equal(t.snippet, "Hi Eddy", "the list shows the client's words, never ours");
  const clientCopies = [...store.copies.values()].filter((c) => store.messages.get(c.message_id)?.direction === "in").map((c) => c.gmail_id);
  const fullFetched = eddy.calls.filter((c) => c.startsWith("full ")).map((c) => c.slice(5)).sort();
  assert.deepEqual(fullFetched, clientCopies.sort(), "bodies fetched only for the client's emails");
  assert.ok(eddy.calls.some((c) => c.startsWith("list from:(")), "the first fill searched for client mail only");
});

test("the same email in two teammates' inboxes is one message with two copies", async () => {
  const { store, eddy, amy, sync } = setup();
  const mail = { from: "ann@tollrealtygroup.com", to: [EDDY, AMY], subject: "Leads?", messageId: "t1@toll", date: NOW - H, text: "Where are my leads" };
  eddy.deliver(mail);
  amy.deliver(mail);
  await sync(EDDY);
  await sync(AMY);
  assert.equal(tickets(store).length, 1);
  assert.equal(store.messages.size, 1);
  assert.deepEqual([...store.copies.values()].map((c) => c.mailbox).sort(), [AMY, EDDY]);
  assert.equal(tickets(store)[0].status, "open");
  assert.equal(tickets(store)[0].match_method, "address", "ann is on the client's record");
});

test("live: the client writes again → Open; Amy answers from her own inbox → Waiting, linked by In-Reply-To", async () => {
  const { store, eddy, amy, sync } = setup();
  eddy.deliver({ from: "owner@gmail.com", subject: "Portal access", messageId: "o1@g", date: NOW - 3 * H });
  eddy.deliver({ from: EDDY, to: ["owner@gmail.com"], subject: "Re: Portal access", messageId: "e1@bs", inReplyTo: "o1@g", date: NOW - 2 * H });
  await sync(EDDY);
  await sync(AMY);
  const t0 = tickets(store)[0];
  assert.equal(t0.status, "waiting");

  eddy.deliver({ from: "owner@gmail.com", to: [EDDY, AMY], subject: "Re: Portal access", messageId: "o2@g", inReplyTo: "e1@bs", references: ["o1@g", "e1@bs"], date: NOW - H });
  await sync(EDDY);
  assert.equal(store.tickets.get(t0.id)!.status, "open");
  assert.ok(store.events.some((e) => e.kind === "reopened" && e.body === "Owner wrote again" || e.kind === "reopened"));

  amy.deliver({ from: `Amy <${AMY}>`, to: ["owner@gmail.com"], subject: "Re: Portal access", messageId: "a1@bs", inReplyTo: "o2@g", references: ["o1@g", "e1@bs", "o2@g"], date: NOW - 0.5 * H });
  await sync(AMY);
  const t = store.tickets.get(t0.id)!;
  assert.equal(t.status, "waiting");
  assert.equal(t.message_count, 4);
  assert.ok(store.events.some((e) => e.kind === "status" && e.body === "Amy replied from Gmail"));
  assert.equal(tickets(store).length, 1);
});

test("THE RULE (user, 20 Nov): inside a client's conversation, anyone who isn't a client address is never stored", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", to: [EDDY], cc: ["vendor@printco.com"], subject: "Signs", messageId: "s1@hb", date: NOW - 3 * H });
  eddy.deliver({ from: "Vendor <vendor@printco.com>", to: [EDDY, "john@myrehomebase.com"], subject: "Re: Signs", messageId: "s2@pc", inReplyTo: "s1@hb", references: ["s1@hb"], date: NOW - 2 * H, text: "Quote attached" });
  eddy.deliver({ from: "New Hire <newhire@myrehomebase.com>", to: [EDDY], subject: "Re: Signs", messageId: "s3@hb", inReplyTo: "s2@pc", references: ["s1@hb", "s2@pc"], date: NOW - H, text: "I'm new here" });
  eddy.deliver({ from: "newhire@myrehomebase.com", subject: "Hello from the new hire", messageId: "s4@hb", date: NOW - H });
  await sync(EDDY);
  assert.equal(store.tickets.size, 1);
  assert.deepEqual([...store.messages.values()].map((m) => m.from_email), ["john@myrehomebase.com"], "only the client's own address is kept — not the vendor, not someone new at the client's company");
  assert.ok(![...store.messages.values()].some((m) => /Quote attached|new here/.test(String(m.body_text))));
});

test("an internal forward inside a client conversation is never stored", async () => {
  const { store, eddy, amy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Contract", messageId: "c1@hb", date: NOW - 2 * H });
  await sync(EDDY);
  await sync(AMY);
  amy.deliver({ from: EDDY, to: [AMY], subject: "Fwd: Contract", messageId: "f1@bs", references: ["c1@hb"], date: NOW - H });
  await sync(AMY);
  assert.equal(store.messages.size, 1);
  assert.equal(tickets(store)[0].status, "open", "a forward to a teammate is not a reply to the client");
});

test("an out-of-office from a client starts nothing; a lead at an unknown domain starts nothing", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Out of office", messageId: "ooo@hb", date: NOW - H, autoSubmitted: "auto-replied" });
  eddy.deliver({ from: "agent@kw.com", subject: "Interested", messageId: "k1@kw", date: NOW - H });
  await sync(EDDY);
  eddy.deliver({ from: "agent@kw.com", subject: "Again", messageId: "k2@kw", date: NOW - 0.5 * H });
  await sync(EDDY);
  assert.equal(store.tickets.size, 0);
  assert.equal(store.messages.size, 0);
});

test("a conversation quiet for over a week is imported as Done", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Old thing", messageId: "old@hb", date: NOW - 12 * D });
  await sync(EDDY);
  const t = tickets(store)[0];
  assert.equal(t.status, "done");
  assert.ok(store.events.some((e) => /Imported as Done/.test(String(e.body))));
});

test("a removed conversation is never imported again, nor its replies", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Private", messageId: "pv1@hb", date: NOW - 2 * H });
  await sync(EDDY);
  const t = tickets(store)[0];
  const copy = [...store.copies.values()][0];
  await store.block([`msg:pv1@hb`, `thread:${EDDY}:${copy.gmail_thread_id}`], EDDY);
  await store.deleteTicket(t.id);
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Re: Private", messageId: "pv2@hb", inReplyTo: "pv1@hb", date: NOW - H });
  await sync(EDDY);
  assert.equal(store.tickets.size, 0);
});

test("history too old → a refill since the last good run, nothing doubled", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "One", messageId: "h1@hb", date: NOW - 3 * H });
  await sync(EDDY);
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Two", messageId: "h2@hb", date: NOW - H });
  eddy.historyFloor = 10_000;
  const r = await sync(EDDY);
  assert.equal(r.mode, "refill");
  assert.equal(store.tickets.size, 2);
  assert.equal(store.messages.size, 2);
});

test("cleanSubject strips reply and forward prefixes", () => {
  assert.equal(cleanSubject("Re: Fwd: RE[2]: Invoice"), "Invoice");
  assert.equal(cleanSubject("   "), "(no subject)");
  assert.equal(cleanSubject("Recap of the call"), "Recap of the call");
});

/* ---------------------------------------------- independent review, 20 Nov: each finding pinned --- */

test("REVIEW 1: an encoded comma in the From name can't pass a stranger off as the client", async () => {
  const { store, eddy, sync } = setup();
  await sync(EDDY);
  eddy.deliver({ from: "attacker@evil.com", rawFrom: "=?utf-8?Q?john@myrehomebase.com=2C?= <attacker@evil.com>", subject: "Please wire", messageId: "x1@evil", date: NOW - H, text: "Please wire to…" });
  eddy.deliver({ from: "attacker@evil.com", rawFrom: "=?utf-8?B?am9obkBteXJlaG9tZWJhc2UuY29tOw==?= <attacker@evil.com>", subject: "Again", messageId: "x2@evil", date: NOW - H, text: "B-encoded" });
  await sync(EDDY);
  assert.equal(store.messages.size, 0);
  assert.equal(store.tickets.size, 0);
});

test("REVIEW 5: a forged From (Gmail could not verify the sender) is not kept", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Forged", messageId: "f1@x", date: NOW - H, text: "spoof", auth: "fail" });
  eddy.deliver({ from: "john@myrehomebase.com", subject: "No verdict", messageId: "f2@x", date: NOW - H, text: "spoof", auth: "none" });
  const r = await sync(EDDY);
  assert.equal(store.messages.size, 0);
  assert.equal(r.unverified, 2);
});

test("REVIEW 4: a client's reply that quotes our answer keeps only the client's words", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Q", messageId: "q1@hb", date: NOW - 3 * H, text: "Question" });
  eddy.deliver({ from: EDDY, to: ["john@myrehomebase.com"], subject: "Re: Q", messageId: "q2@bs", inReplyTo: "q1@hb", date: NOW - 2 * H, text: "TEAM-SECRET answer" });
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Re: Q", messageId: "q3@hb", inReplyTo: "q2@bs", references: ["q1@hb", "q2@bs"], date: NOW - H,
    html: `<div>Thanks, one more thing.</div><div class="gmail_quote"><div>On Tue Eddy wrote:</div><blockquote>TEAM-SECRET answer</blockquote></div>`,
    text: "Thanks, one more thing.\n\nOn Tue, Nov 18, 2026 at 9:00 AM Eddy <eddy@brokerstaffer.com> wrote:\n> TEAM-SECRET answer" });
  await sync(EDDY);
  assert.ok(!JSON.stringify([...store.messages.values()]).includes("TEAM-SECRET"));
  const last = [...store.messages.values()].find((m) => m.rfc_id === "q3@hb")!;
  assert.equal(last.trimmed, true);
  assert.match(String(last.body_text), /^Thanks, one more thing\.$/);
});

test("REVIEW 10: Eddy forwarding the client's email to a vendor is not a reply (stays Open)", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Signs", messageId: "s1@hb", date: NOW - 2 * H, text: "Need signs" });
  await sync(EDDY);
  eddy.deliver({ from: EDDY, to: ["vendor@printco.com"], subject: "Fwd: Signs", messageId: "s2@bs", references: ["s1@hb"], date: NOW - H, text: "Can you quote?" });
  await sync(EDDY);
  assert.equal(store.messages.size, 1);
  assert.equal(tickets(store)[0].status, "open");
});

test("REVIEW 6: a team reply marker keeps no other participants' ids; non-client mail in a removed thread writes nothing", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "A", messageId: "a1@hb", date: NOW - 3 * H, text: "A" });
  eddy.deliver({ from: EDDY, to: ["john@myrehomebase.com"], subject: "Re: A", messageId: "a2@bs", inReplyTo: "a1@hb", references: ["a1@hb"], date: NOW - 2 * H, text: "B" });
  await sync(EDDY);
  const marker = [...store.messages.values()].find((m) => m.direction === "out")!;
  assert.deepEqual([marker.refs, marker.in_reply_to], [[], null]);
  const copy = [...store.copies.values()][0];
  await store.block([`msg:a1@hb`, `thread:${EDDY}:${copy.gmail_thread_id}`], EDDY);
  const before = store.blocks.size;
  eddy.deliver({ from: "stranger@vendor.com", to: [EDDY], subject: "Re: A", messageId: "a3@v", inReplyTo: "a1@hb", references: ["a1@hb"], date: NOW - H, text: "x" });
  await sync(EDDY);
  assert.equal(store.blocks.size, before, "nothing about the stranger is written");
});

test("REVIEW 7a: after a history gap (refill), a client's new email still reopens a Done ticket", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "R", messageId: "r1@hb", date: NOW - 3 * H, text: "R" });
  await sync(EDDY);
  const t = tickets(store)[0];
  await store.updateTicket(t.id, { status: "done", closed_at: new Date(NOW - 2 * H).toISOString() });
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Re: R", messageId: "r2@hb", inReplyTo: "r1@hb", references: ["r1@hb"], date: NOW - H, text: "Again" });
  eddy.historyFloor = 10_000;
  const r = await sync(EDDY);
  assert.equal(r.mode, "refill");
  assert.equal(store.tickets.get(t.id)!.status, "open");
});

test("REVIEW 8: Amy's reply is seen when the client's email was first stored from Eddy's inbox (first fill)", async () => {
  const { store, eddy, amy, sync } = setup();
  const mail = { from: "ann@tollrealtygroup.com", to: [EDDY, AMY], subject: "Leads?", messageId: "l1@toll", date: NOW - 3 * H, text: "Where are my leads" };
  eddy.deliver(mail);
  amy.deliver(mail);
  amy.deliver({ from: AMY, to: ["ann@tollrealtygroup.com"], subject: "Re: Leads?", messageId: "l2@bs", inReplyTo: "l1@toll", references: ["l1@toll"], date: NOW - 2 * H, text: "On it" });
  await sync(EDDY);
  await sync(AMY);
  const t = tickets(store)[0];
  assert.equal(t.status, "waiting");
  assert.equal([...store.messages.values()].filter((m) => m.direction === "out").length, 1);
});

test("REVIEW 2: one bad message is skipped and counted; the mailbox keeps syncing; NULs never reach the database", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Nul", messageId: "n1@hb", date: NOW - 2 * H, text: "bad\u0000byte" });
  eddy.deliver({ from: "ann@tollrealtygroup.com", subject: "Fine", messageId: "n2@toll", date: NOW - H, text: "fine" });
  const real = store.insertMessage.bind(store);
  let n = 0;
  store.insertMessage = async (m) => {
    if (m.rfc_id === "n2@toll" && n++ === 0) throw Object.assign(new Error("value too long"), { code: "22001" });
    return real(m);
  };
  const r = await sync(EDDY);
  assert.equal(r.failed, 1);
  assert.equal(r.historyId !== null, true);
  const kept = [...store.messages.values()].find((m) => m.rfc_id === "n1@hb")!;
  assert.equal(kept.body_text, "badbyte");
});

test("REVIEW 9: a teammate's change made while the sync works on the ticket is not overwritten", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "C", messageId: "c1@hb", date: NOW - 3 * H, text: "C" });
  await sync(EDDY);
  const t = tickets(store)[0];
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Re: C", messageId: "c2@hb", inReplyTo: "c1@hb", references: ["c1@hb"], date: NOW - H, text: "more" });
  store.conflictOnce = true;
  await sync(EDDY);
  const after = store.tickets.get(t.id)!;
  assert.equal(after.message_count, 2, "re-read and re-applied after the conflict");
});
