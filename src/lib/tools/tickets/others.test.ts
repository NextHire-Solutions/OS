import { test } from "node:test";
import assert from "node:assert/strict";

import { buildClientIndex } from "./client-match.ts";
import { FakeGmail } from "./fake-gmail.ts";
import { MemoryTicketStore } from "./memory-store.ts";
import { syncMailbox, type SyncDeps } from "./sync.ts";
import { TICKETS_OTHERS_ON } from "./others-switch.ts";
import { VIEWS, VIEW_LABEL } from "./views.ts";

/*
 * Tickets › Others (24 Nov 2026). The user chose "Every other email" for Eddy's ask: "create a section called others and
 * have the rest of the email go through there … someone within a client's organization may message Amy". sync.test.ts
 * keeps proving the rule without it (deps.others unset); these prove it on.
 */

const NOW = Date.now();
const H = 3_600_000;
const D = 24 * H;
const EDDY = "eddy@brokerstaffer.com";
const AMY = "amy@brokerstaffer.com";
const index = buildClientIndex([
  { id: "homebase", name: "Homebase", status: "active", internal: false, emails: ["john@myrehomebase.com"] },
]);

function setup(others = true) {
  const store = new MemoryTicketStore();
  store.addMailbox(EDDY, { name: "Eddy Boccara" });
  store.addMailbox(AMY, { name: "Amy Anderes" });
  const gmails = new Map([[EDDY, new FakeGmail(EDDY)], [AMY, new FakeGmail(AMY)]]);
  const deps = (mb: string): SyncDeps => ({ store, gmail: gmails.get(mb)!, index, team: new Set([EDDY, AMY, "gabo@gmail.com"]), names: new Map([[EDDY, "Eddy Boccara"], [AMY, "Amy Anderes"]]), now: () => NOW, others });
  const sync = async (mb: string) => {
    const row = store.mailboxes.get(mb)!;
    const r = await syncMailbox(deps(mb), row);
    Object.assign(row, { history_id: r.historyId, backfill_done_at: row.backfill_done_at ?? new Date(NOW).toISOString(), last_ok_at: new Date(NOW).toISOString() });
    return r;
  };
  return { store, amy: gmails.get(AMY)!, eddy: gmails.get(EDDY)!, sync };
}
const tickets = (s: MemoryTicketStore) => [...s.tickets.values()];
const msgsOf = (s: MemoryTicketStore, id: string) => [...s.messages.values()].filter((m) => m.ticket_id === id).sort((a, b) => a.sent_at.localeCompare(b.sent_at));

test("the switch is on in the app, and Others is a view of its own, last", () => {
  assert.equal(TICKETS_OTHERS_ON, true, "the user chose Every other email (24 Nov)");
  assert.equal(VIEWS[VIEWS.length - 1], "others");
  assert.equal(VIEW_LABEL.others, "Others");
});

test("someone who isn't a client writes to Amy: a ticket with no client (Others), their words kept", async () => {
  const { store, amy, sync } = setup();
  amy.deliver({ from: "Sara Lee <sara@newbrokerage.com>", to: [AMY], subject: "Question about your service", messageId: "o1@nb", date: NOW - 2 * H, html: "<p>Hi Amy, what do you charge?</p>" });
  await sync(AMY);
  const all = tickets(store);
  assert.equal(all.length, 1);
  assert.equal(all[0].os_client_id, null, "Others: no client");
  assert.equal(all[0].match_method, null);
  assert.equal(all[0].status, "open");
  assert.equal(all[0].contact_email, "sara@newbrokerage.com");
  const [m] = msgsOf(store, all[0].id);
  assert.equal(m.direction, "in");
  assert.match(String(m.body_text), /what do you charge/, "the email itself is kept, as a client's is");
  assert.equal(all[0].snippet, "Hi Amy, what do you charge?");
});

test("notifications and newsletters go to Others too (every other email); spam and drafts never", async () => {
  const { store, amy, sync } = setup();
  amy.deliver({ from: "Calendly <notifications@calendly.com>", subject: "New event: Intro call", messageId: "cal@c", date: NOW - 3 * H, autoSubmitted: "auto-generated", text: "A new event was scheduled" });
  amy.deliver({ from: "news@realty.com", subject: "Weekly market", messageId: "nl@r", date: NOW - 2 * H, text: "This week" });
  amy.deliver({ from: "spam@bad.com", subject: "You won", messageId: "sp@b", date: NOW - H, labels: ["SPAM"] });
  await sync(AMY);
  assert.deepEqual(tickets(store).map((t) => t.contact_email).sort(), ["news@realty.com", "notifications@calendly.com"]);
  assert.ok(tickets(store).every((t) => t.os_client_id === null));
});

test("Eddy's case: someone new at the client's company writes in the client's conversation — it joins the client's ticket", async () => {
  const { store, amy, sync } = setup();
  amy.deliver({ from: "john@myrehomebase.com", to: [AMY], cc: ["newhire@myrehomebase.com"], subject: "Signs", messageId: "s1@hb", date: NOW - 3 * H, text: "Need signs" });
  await sync(AMY);
  const t = tickets(store)[0];
  amy.deliver({ from: AMY, to: ["john@myrehomebase.com"], subject: "Re: Signs", messageId: "s2@bs", inReplyTo: "s1@hb", references: ["s1@hb"], date: NOW - 2 * H, text: "On it" });
  await sync(AMY);
  assert.equal(store.tickets.get(t.id)!.status, "waiting");
  amy.deliver({ from: "New Hire <newhire@myrehomebase.com>", to: [AMY], subject: "Re: Signs", messageId: "s3@hb", inReplyTo: "s2@bs", references: ["s1@hb", "s2@bs"], date: NOW - H, text: "I'm new here, can I get them too?" });
  await sync(AMY);
  assert.equal(store.tickets.size, 1, "no second ticket: it's the client's conversation");
  const after = store.tickets.get(t.id)!;
  assert.equal(after.os_client_id, "homebase");
  assert.equal(after.status, "open", "someone on the client's side is waiting on us again");
  assert.deepEqual(msgsOf(store, t.id).map((m) => [m.direction, m.from_email]), [["in", "john@myrehomebase.com"], ["out", AMY], ["in", "newhire@myrehomebase.com"]]);
  assert.match(String(msgsOf(store, t.id)[2].body_text), /I'm new here/);
});

test("our reply in an Others conversation is noted like a reply to a client: a dated marker, ticket to Waiting", async () => {
  const { store, amy, sync } = setup();
  amy.deliver({ from: "sara@newbrokerage.com", to: [AMY], subject: "Pricing", messageId: "p1@nb", date: NOW - 3 * H, text: "Pricing?" });
  await sync(AMY);
  amy.deliver({ from: AMY, to: ["sara@newbrokerage.com"], subject: "Re: Pricing", messageId: "p2@bs", inReplyTo: "p1@nb", references: ["p1@nb"], date: NOW - 2 * H, text: "Here are our prices" });
  await sync(AMY);
  const t = tickets(store)[0];
  assert.equal(t.status, "waiting");
  const reply = msgsOf(store, t.id)[1];
  assert.equal(reply.direction, "out");
  assert.deepEqual([reply.subject, reply.body_text, reply.body_html, reply.to_list], [null, null, null, []], "our words are never stored");
});

test("unchanged with Others on: a forward to a vendor inside a CLIENT conversation is not a reply", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Signs", messageId: "s1@hb", date: NOW - 2 * H, text: "Need signs" });
  await sync(EDDY);
  eddy.deliver({ from: EDDY, to: ["vendor@printco.com"], subject: "Fwd: Signs", messageId: "s2@bs", references: ["s1@hb"], date: NOW - H, text: "Can you quote?" });
  await sync(EDDY);
  assert.equal(store.messages.size, 1);
  assert.equal(tickets(store)[0].status, "open");
});

test("unchanged with Others on: a forged client address is refused, not filed under Others", async () => {
  const { store, eddy, sync } = setup();
  eddy.deliver({ from: "john@myrehomebase.com", subject: "Wire the money", messageId: "f1@evil", date: NOW - H, text: "urgent", auth: "fail" });
  const r = await sync(EDDY);
  assert.equal(store.tickets.size, 0);
  assert.equal(r.unverified, 1);
});

test("unchanged with Others on: mail only between teammates leaves no trace; calendar invitations are never tickets", async () => {
  const { store, amy, sync } = setup();
  amy.deliver({ from: EDDY, to: [AMY], subject: "Lunch?", messageId: "t1@bs", date: NOW - 2 * H, text: "12?" });
  amy.deliver({ from: "Sara <sara@newbrokerage.com>", subject: "Invitation: Call @ Thu Nov 27, 2025 2pm - 3pm (EST)", messageId: "i1@cal", date: NOW - H, headers: [{ name: "Sender", value: "Google Calendar <calendar-notification@google.com>" }] });
  await sync(AMY);
  assert.equal(store.tickets.size, 0);
  assert.equal(store.messages.size, 0);
});

test("first fill with Others on reads every email of the window; one quiet for over a week is imported as Done", async () => {
  const { store, amy, sync } = setup();
  amy.deliver({ from: "old@vendor.com", subject: "Old offer", messageId: "o1@v", date: NOW - 10 * D, text: "old" });
  amy.deliver({ from: "fresh@vendor.com", subject: "New offer", messageId: "o2@v", date: NOW - D, text: "new" });
  const r = await sync(AMY);
  assert.equal(r.mode, "fill");
  assert.ok(amy.calls.some((c) => c.startsWith("list newer_than:30d -in:sent")), "the fill also searched every email, not only client addresses");
  const byEmail = new Map(tickets(store).map((t) => [t.contact_email, t.status]));
  assert.equal(byEmail.get("old@vendor.com"), "done");
  assert.equal(byEmail.get("fresh@vendor.com"), "open");
});

test("Others off: the old rule exactly — nothing but client addresses", async () => {
  const { store, amy, sync } = setup(false);
  amy.deliver({ from: "sara@newbrokerage.com", subject: "Question", messageId: "q1@nb", date: NOW - H, text: "hi" });
  const r = await sync(AMY);
  assert.equal(store.tickets.size, 0);
  assert.ok(!amy.calls.some((c) => c.startsWith("list newer_than:")), "no every-email search");
  assert.equal(r.stored, 0);
});
