import { test } from "node:test";
import assert from "node:assert/strict";

import { act, applyMessage, blankTicket, settleImported, shortAge, wake, waitTone, type IncomingMessage, type TicketState } from "./ticket-rules.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-11-20T15:00:00Z");
const at = (h: number) => new Date(T0 + h * H).toISOString();
const msg = (direction: "in" | "out", h: number, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({ direction, sentAt: at(h), auto: false, snippet: `${direction}@${h}`, who: direction === "in" ? "Jane" : "Amy", ...extra });

/** Apply messages in the order given, as the sync would. */
function run(start: TicketState, msgs: IncomingMessage[], importing = false) {
  let s = start;
  const events: unknown[] = [];
  for (const m of msgs) {
    const c = applyMessage(s, m, importing);
    s = { ...s, ...c.patch };
    events.push(...c.events);
  }
  return { s, events };
}

test("client writes, we reply: Open → Waiting, waiting-since cleared, first response recorded", () => {
  const { s, events } = run(blankTicket(), [msg("in", 0), msg("out", 2)]);
  assert.equal(s.status, "waiting");
  assert.equal(s.waiting_since, null);
  assert.equal(s.first_response_at, at(2));
  assert.equal(s.message_count, 2);
  assert.equal(s.snippet, "out@2");
  assert.deepEqual(events, [{ kind: "status", actor: null, from_value: "open", to_value: "waiting", body: "Amy replied from Gmail" }]);
});

test("the client writes again: back to Open, assignee kept, waiting counts from the first unanswered message", () => {
  const start = { ...blankTicket(), assignee: "amy@brokerstaffer.com" };
  const { s, events } = run(start, [msg("in", 0), msg("out", 1), msg("in", 3), msg("in", 5)]);
  assert.equal(s.status, "open");
  assert.equal(s.assignee, "amy@brokerstaffer.com");
  assert.equal(s.waiting_since, at(3), "from the first of the two unanswered emails");
  assert.equal(events.filter((e: any) => e.kind === "reopened").length, 1);
});

test("Done and Ignored reopen on a new client email; snoozed wakes too", () => {
  for (const status of ["done", "ignored"] as const) {
    const s0 = { ...run(blankTicket(), [msg("in", 0)]).s, status, closed_at: at(1), closed_by: "eddy@brokerstaffer.com" };
    const { s } = run(s0, [msg("in", 2)]);
    assert.equal(s.status, "open", status);
    assert.equal(s.closed_at, null);
  }
  const snoozed = { ...run(blankTicket(), [msg("in", 0), msg("out", 1)]).s, snoozed_until: at(48) };
  const { s, events } = run(snoozed, [msg("in", 2)]);
  assert.equal(s.status, "open");
  assert.equal(s.snoozed_until, null);
  assert.equal((events[events.length - 1] as any).from_value, "snoozed");
});

test("an email older than the close (arriving late from another mailbox) does not reopen", () => {
  const s0 = { ...run(blankTicket(), [msg("in", 0), msg("out", 1)]).s, status: "done" as const, closed_at: at(5) };
  assert.equal(run(s0, [msg("in", 4)]).s.status, "done");
});

test("an out-of-office or list mail never opens anything", () => {
  const s0 = run(blankTicket(), [msg("in", 0), msg("out", 1)]).s;
  const { s, events } = run(s0, [msg("in", 2, { auto: true })]);
  assert.equal(s.status, "waiting");
  assert.equal(s.waiting_since, null);
  assert.deepEqual(events, []);
  assert.equal(s.last_inbound_at, at(2));
});

test("out of order: our reply processed before the client's earlier email still counts as answered", () => {
  const { s } = run(blankTicket(), [msg("out", 2), msg("in", 0)], true);
  assert.equal(s.waiting_since, null, "the reply came after it");
  assert.equal(s.first_message_at, at(0));
  assert.equal(s.last_message_at, at(2));
  assert.equal(s.snippet, "out@2", "the snippet is the latest message's");
});

test("importing writes no status events; the end state is settled once", () => {
  const { s, events } = run(blankTicket(), [msg("in", 0), msg("out", 1), msg("in", 2)], true);
  assert.deepEqual(events, []);
  assert.deepEqual(settleImported(s, true, T0 + 3 * H).patch, { status: "open" });
  assert.deepEqual(settleImported(s, false, T0 + 3 * H).patch, { status: "waiting" });
  const old = settleImported(s, true, T0 + 10 * 24 * H);
  assert.equal(old.patch.status, "done");
  assert.match(String(old.events[0].body), /no new email for 9 days/);
});

test("people's actions: assign, done, reopen, snooze and cancel; no-ops return null", () => {
  const s0 = run(blankTicket(), [msg("in", 0)]).s;
  const a = act(s0, { type: "assign", to: "Amy@BrokerStaffer.com" }, "eddy@brokerstaffer.com", T0)!;
  assert.deepEqual(a.patch, { assignee: "amy@brokerstaffer.com" });
  assert.equal(act({ ...s0, assignee: "amy@brokerstaffer.com" }, { type: "assign", to: "amy@brokerstaffer.com" }, "x", T0), null);
  const d = act(s0, { type: "status", to: "done" }, "eddy@brokerstaffer.com", T0)!;
  assert.equal(d.patch.status, "done");
  assert.equal(d.patch.closed_by, "eddy@brokerstaffer.com");
  assert.equal(act({ ...s0, ...d.patch } as TicketState, { type: "status", to: "open" }, "x", T0)!.patch.closed_at, null);
  assert.equal(act(s0, { type: "status", to: "open" }, "x", T0), null);
  const z = act(s0, { type: "snooze", until: at(24) }, "x", T0)!;
  assert.deepEqual([z.patch.status, z.patch.snoozed_until], ["waiting", at(24)]);
  assert.equal(act(s0, { type: "snooze", until: at(-1) }, "x", T0), null, "a time already past is refused");
  assert.equal(act({ ...s0, ...z.patch } as TicketState, { type: "snooze", until: null }, "x", T0)!.patch.status, "open");
});

test("wake: a snooze whose time has come goes back to Open", () => {
  const s0 = { ...blankTicket(), status: "waiting" as const, snoozed_until: at(1) };
  assert.equal(wake(s0, T0), null);
  assert.deepEqual(wake(s0, T0 + 2 * H)!.patch, { snoozed_until: null, status: "open" });
});

test("wait tones and short ages", () => {
  assert.equal(waitTone(at(0), T0 + 1 * H), "fresh");
  assert.equal(waitTone(at(0), T0 + 5 * H), "warn");
  assert.equal(waitTone(at(0), T0 + 30 * H), "late");
  assert.equal(waitTone(null, T0), null);
  assert.deepEqual([shortAge(at(0), T0 + 30_000), shortAge(at(0), T0 + 0.5 * H), shortAge(at(0), T0 + 5 * H), shortAge(at(0), T0 + 50 * H), shortAge(at(0), T0 + 400 * H)], ["now", "30m", "5h", "2d", "2w"]);
});
