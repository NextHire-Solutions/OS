import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_TRIES, afterAttempt, cyclePauseLive, cyclePauseScheduled, judge, progressState, recordForCycle, sharedWith, splitShared,
  type CycleFacts, type CyclePauseRecord, type JudgeInput,
} from "./cycle-pause-model.ts";

const cycle = (o: Partial<CycleFacts> = {}): CycleFacts => ({
  start: new Date("2026-11-03T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z"), target: 6, required: 6, delivered: 2, ...o,
});
const input = (o: Partial<JudgeInput> = {}): JudgeInput => ({ status: "active", clientPaused: false, perLead: false, cycle: cycle(), record: null, ...o });
const record = (o: Partial<CyclePauseRecord> = {}): CyclePauseRecord => ({
  os_client_id: "os-1", cycle_start: "2026-11-03", cycle_end: "2026-12-01", required: 6, delivered: 6,
  reached_at: "2026-11-20T10:00:00Z", paused: [], left_running: [], to_retry: [], updated_at: "2026-11-20T10:00:00Z", ...o,
});
const bison = (id: string, name = `Campaign ${id}`) => ({ platform: "bison" as const, id, int_id: Number(id.replace(/\D/g, "")) || 1, name });

describe("cycle pause: switches", () => {
  it("acts only with OS_CYCLE_PAUSE=1, and runs only on Railway with the OS database", () => {
    assert.equal(cyclePauseLive({}), false);
    assert.equal(cyclePauseLive({ OS_CYCLE_PAUSE: "true" }), false);
    assert.equal(cyclePauseLive({ OS_CYCLE_PAUSE: "1" }), true);
    assert.equal(cyclePauseScheduled({ MASTER_INBOX_SUPABASE_URL: "x" }), false);
    assert.equal(cyclePauseScheduled({ RAILWAY_ENVIRONMENT_NAME: "production" }), false);
    assert.equal(cyclePauseScheduled({ RAILWAY_ENVIRONMENT_NAME: "production", MASTER_INBOX_SUPABASE_URL: "x" }), true);
  });
});

describe("cycle pause: judge", () => {
  it("pauses an Active client whose cycle reached its due", () => {
    assert.deepEqual(judge(input({ cycle: cycle({ delivered: 6 }) })), { kind: "reached", delivered: 6, required: 6 });
    assert.deepEqual(judge(input({ cycle: cycle({ delivered: 9 }) })), { kind: "reached", delivered: 9, required: 6 });
  });

  it("measures against the due with the carried shortfall, as Intros / Billing shows it", () => {
    // Target 6 plus 2 carried in: 6 delivered is not enough.
    assert.deepEqual(judge(input({ cycle: cycle({ target: 6, required: 8, delivered: 6 }) })), { kind: "below", delivered: 6, required: 8 });
  });

  it("leaves a client below its due running", () => {
    assert.deepEqual(judge(input()), { kind: "below", delivered: 2, required: 6 });
  });

  it("acts on Active clients only", () => {
    for (const status of ["onboarding", "paused", "churned"]) assert.equal(judge(input({ status, cycle: cycle({ delivered: 6 }) })).kind, "skip");
    assert.deepEqual(judge(input({ status: null, cycle: cycle({ delivered: 6 }) })), { kind: "skip", reason: "no status on its record" });
    assert.equal(judge(input({ status: " Active ", cycle: cycle({ delivered: 6 }) })).kind, "reached");
  });

  it("leaves a client marked paused, one billed per lead, one with no billing date and one with no target", () => {
    assert.equal(judge(input({ clientPaused: true, cycle: cycle({ delivered: 6 }) })).kind, "skip");
    assert.deepEqual(judge(input({ perLead: true, cycle: cycle({ delivered: 6 }) })), { kind: "skip", reason: "billed per lead: Lead caps pauses it" });
    assert.deepEqual(judge(input({ cycle: null })), { kind: "skip", reason: "no billing date" });
    assert.deepEqual(judge(input({ cycle: cycle({ target: 0, required: 0, delivered: 3 }) })), { kind: "skip", reason: "no target set" });
  });

  it("acts once per cycle: a cycle already acted on is done, whatever a person resumed since", () => {
    assert.deepEqual(judge(input({ cycle: cycle({ delivered: 7 }), record: record() })), { kind: "done" });
  });

  it("tries again only what is still to pause from this cycle", () => {
    const list = [{ ...bison("b1"), error: "EmailBison 500" }];
    assert.deepEqual(judge(input({ cycle: cycle({ delivered: 6 }), record: record({ to_retry: list }) })), { kind: "retry", list });
  });

  it("gives up on a campaign after MAX_TRIES runs: the cycle counts as done, the campaign stays listed", () => {
    const stuck = { ...bison("b1"), error: "EmailBison 500", attempts: MAX_TRIES };
    const fresh = { ...bison("b2"), error: "EmailBison 500", attempts: MAX_TRIES - 1 };
    assert.deepEqual(judge(input({ cycle: cycle({ delivered: 6 }), record: record({ to_retry: [stuck] }) })), { kind: "done" });
    assert.deepEqual(judge(input({ cycle: cycle({ delivered: 6 }), record: record({ to_retry: [stuck, fresh] }) })), { kind: "retry", list: [fresh] });
  });

  it("a due with a half (14-day billing of an odd monthly target) is reached at the next whole introduction", () => {
    assert.equal(judge(input({ cycle: cycle({ target: 2.5, required: 2.5, delivered: 2 }) })).kind, "below");
    assert.deepEqual(judge(input({ cycle: cycle({ target: 2.5, required: 2.5, delivered: 3 }) })), { kind: "reached", delivered: 3, required: 2.5 });
  });

  it("a new cycle with no record is judged afresh, so it pauses again when its target is reached", () => {
    const next = cycle({ start: new Date("2026-12-01T00:00:00Z"), end: new Date("2026-12-29T00:00:00Z"), delivered: 6 });
    const r = recordForCycle([record()], next);
    assert.equal(r, null);
    assert.equal(judge(input({ cycle: next, record: r })).kind, "reached");
  });
});

describe("cycle pause: the record for the cycle", () => {
  it("finds the record made during this cycle, even if its stored dates moved a day", () => {
    const moved = record({ cycle_start: "2026-11-04", cycle_end: "2026-12-02", reached_at: "2026-11-20T10:00:00Z" });
    assert.equal(recordForCycle([moved], cycle()), moved);
  });

  it("ignores the cycle before and the one after", () => {
    const before = record({ cycle_start: "2026-10-06", cycle_end: "2026-11-03", reached_at: "2026-10-30T10:00:00Z" });
    const after = record({ cycle_start: "2026-12-01", cycle_end: "2026-12-29", reached_at: "2026-12-10T10:00:00Z" });
    assert.equal(recordForCycle([before, after], cycle()), null);
  });

  it("a record made on the last billing date belongs to the cycle that billed that day, not this one", () => {
    assert.equal(recordForCycle([record({ reached_at: "2026-11-03T18:00:00Z" })], cycle()), null);
    assert.ok(recordForCycle([record({ reached_at: "2026-12-01T18:00:00Z" })], cycle()), "the next billing date is still this cycle");
  });

  it("when Stripe moves the charge date earlier, last cycle's pause doesn't cover the new cycle (review, 20 Nov)", () => {
    const last = record({ cycle_start: "2026-11-03", cycle_end: "2026-12-01", reached_at: "2026-11-20T10:00:00Z" });
    const moved = cycle({ start: new Date("2026-11-28T00:00:00Z"), end: new Date("2026-12-26T00:00:00Z") });
    assert.equal(recordForCycle([last], moved), null);
  });
});

describe("cycle pause: shared campaigns", () => {
  const clients = [
    { id: "ch-1", name: "Douglas Elliman Las Vegas", instantly_campaign_ids: [], bison_campaign_ids: ["b1", "b2"] },
    { id: "ch-2", name: "Douglas Elliman Los Angeles", instantly_campaign_ids: ["i9"], bison_campaign_ids: ["b2"] },
  ];

  it("names the other clients linked to a campaign", () => {
    const m = sharedWith("ch-1", [bison("b1"), bison("b2"), { platform: "instantly", id: "i9" }], clients);
    assert.deepEqual([...m.entries()], [["bison:b2", ["Douglas Elliman Los Angeles"]], ["instantly:i9", ["Douglas Elliman Los Angeles"]]]);
  });

  it("matches the platform as well as the id", () => {
    assert.equal(sharedWith("ch-1", [{ platform: "bison", id: "i9" }], clients).size, 0);
  });

  it("leaves a shared campaign running, with the reason, and pauses the rest", () => {
    const sending = [bison("b1"), bison("b2")];
    const { toPause, leftRunning } = splitShared(sending, sharedWith("ch-1", sending, clients));
    assert.deepEqual(toPause.map((c) => c.id), ["b1"]);
    assert.deepEqual(leftRunning, [{ ...bison("b2"), reason: "also linked to Douglas Elliman Los Angeles" }]);
  });
});

describe("cycle pause: after an attempt", () => {
  it("records what paused, retries failures and unread statuses, and drops the rest", () => {
    const r = afterAttempt(
      { paused: [{ ...bison("b0"), paused_at: "2026-11-20T09:00:00Z" }] },
      { ok: [bison("b1")], failed: [{ campaign: bison("b2"), error: "EmailBison 500" }], unread: [bison("b3")] },
      "2026-11-20T10:00:00Z",
    );
    assert.deepEqual(r.paused.map((c) => [c.id, c.paused_at]), [["b0", "2026-11-20T09:00:00Z"], ["b1", "2026-11-20T10:00:00Z"]]);
    assert.deepEqual(r.to_retry, [{ ...bison("b2"), error: "EmailBison 500", attempts: 1 }, { ...bison("b3"), error: "its status couldn't be read", attempts: 1 }]);
  });

  it("a campaign that pauses on a retry leaves the retry list", () => {
    const r = afterAttempt({ paused: [] }, { ok: [bison("b2")], failed: [], unread: [] }, "2026-11-20T10:15:00Z");
    assert.deepEqual(r.to_retry, []);
    assert.equal(r.paused.length, 1);
  });

  it("counts each try, and keeps a campaign given up on (not tried) as it was", () => {
    const prev = [{ ...bison("b1"), error: "EmailBison 500", attempts: 3 }, { ...bison("b9"), error: "EmailBison 500", attempts: MAX_TRIES }];
    const r = afterAttempt({ paused: [], to_retry: prev }, { ok: [], failed: [{ campaign: bison("b1"), error: "EmailBison 502" }], unread: [], tried: [bison("b1")] }, "2026-11-20T10:30:00Z");
    assert.deepEqual(r.to_retry.map((c) => [c.id, c.attempts, c.error]), [["b1", 4, "EmailBison 502"], ["b9", MAX_TRIES, "EmailBison 500"]]);
  });
});

describe("cycle pause: what the screens show", () => {
  it("shows Paused once there is a record, else what the rules say now", () => {
    assert.equal(progressState({ kind: "done" }, record()).state, "paused");
    assert.equal(progressState({ kind: "below", delivered: 1, required: 6 }, record()).state, "paused");
    assert.equal(progressState({ kind: "reached", delivered: 6, required: 6 }, null).state, "reached");
    assert.equal(progressState({ kind: "below", delivered: 1, required: 6 }, null).state, "below");
    assert.deepEqual(progressState({ kind: "skip", reason: "no target set" }, null), { state: "skipped", why: "no target set" });
  });
});

describe("cycle pause: when a cycle reached its due", async () => {
  const { reachedAt } = await import("./cycle-pause-model.ts");
  const CY = { start: new Date("2026-11-03T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") };
  const AS_OF = new Date("2026-11-25T12:00:00Z");

  it("is the introduction that made the count reach the due, in the order they were made", () => {
    const d = ["2026-11-10T09:00:00Z", "2026-11-04T09:00:00Z", "2026-11-12T09:00:00Z", "2026-11-06T09:00:00Z"];
    assert.equal(reachedAt(d, CY, 3, AS_OF), "2026-11-10T09:00:00Z");
  });

  it("counts as Client Health does: not on the last billing date, yes on the next one, and nothing after today", () => {
    assert.equal(reachedAt(["2026-11-03T22:00:00Z", "2026-11-05T09:00:00Z"], CY, 2, AS_OF), null, "Nov 3 belongs to the cycle billed that day");
    assert.equal(reachedAt(["2026-11-05T09:00:00Z", "2026-12-01T09:00:00Z"], CY, 2, new Date("2026-12-01T20:00:00Z")), "2026-12-01T09:00:00Z");
    assert.equal(reachedAt(["2026-11-05T09:00:00Z", "2026-11-26T09:00:00Z"], CY, 2, AS_OF), null, "Nov 26 is after today");
  });

  it("a due with a half is reached at the next whole introduction", () => {
    const d = ["2026-11-04T09:00:00Z", "2026-11-05T09:00:00Z", "2026-11-06T09:00:00Z"];
    assert.equal(reachedAt(d, CY, 2.5, AS_OF), "2026-11-06T09:00:00Z");
    assert.equal(reachedAt(d.slice(0, 2), CY, 2.5, AS_OF), null);
  });
});

describe("cycle pause: only after the switch-on", () => {
  const at = (reached: string | null) => input({ cycle: cycle({ delivered: 6, reachedAt: reached }), liveSince: "2026-11-20T15:00:00Z" });
  it("reached after the switch-on: paused", () => {
    assert.equal(judge(at("2026-11-20T15:10:00Z")).kind, "reached");
  });
  it("reached before it, or when can't be told: left to the team", () => {
    assert.deepEqual(judge(at("2026-11-18T10:00:00Z")), { kind: "before", delivered: 6, required: 6, reachedAt: "2026-11-18T10:00:00Z" });
    assert.equal(judge(at(null)).kind, "before");
  });
  it("a cycle already acted on stays done, whatever the switch-on", () => {
    assert.equal(judge({ ...at("2026-11-18T10:00:00Z"), record: record() }).kind, "done");
  });
  it("shown as before on the screens", () => {
    assert.equal(progressState({ kind: "before", delivered: 6, required: 6, reachedAt: null }, null).state, "before");
  });
});
