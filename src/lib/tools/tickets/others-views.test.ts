/*
 * Tickets › Others (24 Nov 2026) on the screen: a ticket with no client is listed and counted ONLY under Others; every
 * client view (Open, Mine, Unassigned, Waiting, Snoozed, Done, All) leaves it out; counts still equal what each view
 * lists; and the rail's "Client email" badge never counts Others.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { configureFakeEnvironment, FakePostgrest } from "../master-inbox/test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;

const { listTickets, countViews, COUNTED_VIEWS } = await import("./service.ts");

const ME = "amy@brokerstaffer.com";
const ACME = "11111111-1111-4111-8111-111111111111";

function seed() {
  const t = (n: number, status: string, client: string | null, extra: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, number: 2000 + n, status, os_client_id: client,
    assignee: null, snoozed_until: null, subject: `Ticket ${n}`, last_activity_at: `2026-11-${String(10 + n).padStart(2, "0")}T00:00:00Z`,
    updated_at: "2026-11-20T00:00:00Z", waiting_since: null, closed_at: null, ...extra,
  });
  db.seed("os_tickets", [
    t(1, "open", ACME), t(2, "waiting", ACME), t(3, "done", ACME),
    // Others: no client — open, assigned to me, waiting, done, and one marked Not a ticket.
    t(4, "open", null), t(5, "open", null, { assignee: ME }), t(6, "waiting", null), t(7, "done", null), t(8, "ignored", null),
  ]);
  db.seed("os_ticket_mailboxes", [{ email: ME, name: "Amy", state: "ok" }]);
  db.seed("os_ticket_copies", []);
}

test("counts: the client views leave Others out; Others counts its own (not 'Not a ticket')", async () => {
  seed();
  const { counts } = await countViews(ME);
  assert.ok(COUNTED_VIEWS.includes("others"));
  assert.equal(counts.open, 1, "Open: the client's one, not the two open Others");
  assert.equal(counts.mine, 0, "Mine: the Others ticket assigned to me isn't client work");
  assert.equal(counts.unassigned, 1);
  assert.equal(counts.waiting, 1);
  assert.equal(counts.done, 1);
  assert.equal(counts.all, 3, "All = every CLIENT conversation");
  assert.equal(counts.others, 4, "Others: open, assigned, waiting, done — not the ignored one");
});

test("lists: Others lists exactly the tickets with no client; Open and All never show them; counts match lists", async () => {
  seed();
  const others = await listTickets({ view: "others", me: ME, admin: true });
  assert.equal(others.total, 4);
  assert.ok(others.rows.every((r) => r.client === null));
  assert.equal(others.counts.others, others.total);
  for (const view of ["open", "all", "mine", "done"] as const) {
    const r = await listTickets({ view, me: ME, admin: true });
    assert.ok(r.rows.every((x) => x.client !== null), `${view} shows no Others ticket`);
    assert.equal(r.counts[view], r.total, `${view}: count equals list`);
  }
});

test("a client filter set: Others is empty (it has no client), client views unchanged", async () => {
  seed();
  const r = await listTickets({ view: "others", me: ME, admin: true, client: ACME });
  assert.equal(r.total, 0);
  assert.equal(r.counts.open, 1);
});

test("the rail's Client email badge counts client conversations only", () => {
  const src = fs.readFileSync(new URL("../../workspace/badges.ts", import.meta.url), "utf8");
  assert.match(src, /osTable\("os_tickets"\)\.select\("id", \{ count: "exact", head: true \}\)\.eq\("status", "open"\)\.not\("os_client_id", "is", null\)/);
});
