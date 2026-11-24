/*
 * Ticket counts (24 Nov, client: "only 6 tickets are displayed when the account shows a total of 233 … ensure ticket
 * counts and displayed records are consistent with their intended scope").
 *
 * Found: Connected inboxes' "Tickets" counted email COPIES (one per email, the team's reply markers too), and the
 * view counts ignored the Client / Received by filters while the list followed them. Pinned here:
 *   - every view's count equals what that view lists, with and without filters;
 *   - Done and All are counted, and Open + Waiting + Snoozed + Done = All;
 *   - an inbox reports its distinct tickets (Not a ticket left out) and, separately, its emails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../master-inbox/test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;

const { listTickets, countViews, mailboxCounts, COUNTED_VIEWS } = await import("./service.ts");

const ME = "amy@brokerstaffer.com";
const ACME = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const AMY = "amy@brokerstaffer.com";
const EDDY = "eddy@brokerstaffer.com";

function seed() {
  const t = (n: number, status: string, client: string, extra: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, number: 1000 + n, status, os_client_id: client,
    assignee: null, snoozed_until: null, subject: `Ticket ${n}`, last_activity_at: `2026-11-${String(10 + n).padStart(2, "0")}T00:00:00Z`,
    updated_at: "2026-11-20T00:00:00Z", waiting_since: null, closed_at: null, ...extra,
  });
  const tickets = [
    t(1, "open", ACME), t(2, "open", ACME, { assignee: ME }), t(3, "open", BETA),
    t(4, "waiting", ACME), t(5, "waiting", BETA, { snoozed_until: "2026-12-01T00:00:00Z" }),
    t(6, "done", ACME), t(7, "done", ACME), t(8, "done", BETA), t(9, "ignored", ACME),
  ];
  db.seed("os_tickets", tickets);
  db.seed("os_ticket_mailboxes", [{ email: AMY, name: "Amy", state: "ok" }, { email: EDDY, name: "Eddy", state: "ok" }]);
  // Amy's inbox: 3 tickets, 7 emails (several emails per ticket, one on a Not-a-ticket); Eddy's: none.
  const copy = (n: number, g: string, ticket: number) => ({ mailbox: AMY, gmail_id: g, gmail_thread_id: `th${ticket}`, message_id: `m-${g}`, ticket_id: tickets[ticket - 1].id });
  db.seed("os_ticket_copies", [copy(1, "g1", 1), copy(2, "g2", 1), copy(3, "g3", 1), copy(4, "g4", 4), copy(5, "g5", 6), copy(6, "g6", 6), copy(7, "g7", 9)].map(({ ...r }) => r));
  return tickets;
}

const viewsListed = ["open", "mine", "unassigned", "waiting", "snoozed", "done", "all"] as const;

async function assertCountsMatchLists(filters: { client?: string; mailbox?: string }, label: string) {
  for (const view of viewsListed) {
    const r = await listTickets({ view, me: ME, admin: true, ...filters });
    assert.equal(r.counts[view], r.total, `${label}: the ${view} count equals what the ${view} view lists`);
    assert.equal(r.rows.length, r.total, `${label}: ${view} lists every ticket it counts`);
  }
}

test("with no filter: every view's count equals its list, Done and All included", async () => {
  seed();
  const { counts } = await countViews(ME);
  for (const v of COUNTED_VIEWS) assert.equal(typeof counts[v], "number", `${v} is counted`);
  assert.deepEqual(
    { open: counts.open, mine: counts.mine, unassigned: counts.unassigned, waiting: counts.waiting, snoozed: counts.snoozed, done: counts.done, all: counts.all },
    { open: 3, mine: 1, unassigned: 2, waiting: 1, snoozed: 1, done: 3, all: 8 },
  );
  assert.equal(counts.open! + counts.waiting! + counts.snoozed! + counts.done!, counts.all, "the parts add up to All (Not a ticket is in none)");
  await assertCountsMatchLists({}, "no filter");
});

test("a Client filter: the counts follow it, exactly as the list does", async () => {
  seed();
  const r = await listTickets({ view: "open", me: ME, admin: true, client: ACME });
  assert.deepEqual({ open: r.counts.open, waiting: r.counts.waiting, done: r.counts.done, all: r.counts.all }, { open: 2, waiting: 1, done: 2, all: 5 });
  await assertCountsMatchLists({ client: ACME }, "client filter");
});

test("a Received by filter: only the tickets that inbox received are counted and listed", async () => {
  seed();
  const r = await listTickets({ view: "all", me: ME, admin: true, mailbox: AMY });
  assert.equal(r.total, 3, "tickets 1, 4 and 6 (9 is Not a ticket)");
  assert.deepEqual({ open: r.counts.open, waiting: r.counts.waiting, done: r.counts.done }, { open: 1, waiting: 1, done: 1 });
  await assertCountsMatchLists({ mailbox: AMY }, "inbox filter");
  const none = await listTickets({ view: "open", me: ME, admin: true, mailbox: EDDY });
  assert.equal(none.total, 0);
  for (const v of COUNTED_VIEWS) assert.equal(none.counts[v], 0, `an inbox with no tickets shows 0 in ${v}`);
});

test("an inbox reports its tickets and its emails separately (the 233 was emails)", async () => {
  seed();
  assert.deepEqual(await mailboxCounts(AMY), { tickets: 3, emails: 7 });
  assert.deepEqual(await mailboxCounts(EDDY), { tickets: 0, emails: 0 });
});

test("an inbox with more than 1,000 emails is counted in full, each ticket once", async () => {
  const tickets = seed();
  const many = Array.from({ length: 2345 }, (_, i) => ({ mailbox: AMY, gmail_id: `x${String(i).padStart(5, "0")}`, gmail_thread_id: "t", message_id: `mm${i}`, ticket_id: tickets[i % 8].id }));
  db.seed("os_ticket_copies", many);
  assert.deepEqual(await mailboxCounts(AMY), { tickets: 8, emails: 2345 }, "8 tickets (the 9th, Not a ticket, is not among them)");
});
