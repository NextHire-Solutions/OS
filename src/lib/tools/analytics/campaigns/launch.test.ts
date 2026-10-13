import { test } from "node:test";
import assert from "node:assert/strict";

import { launchActionFor, launchChecks, launchSummary, launchVerdict, type LaunchFacts } from "./launch.ts";

const ready = (over: Partial<LaunchFacts> = {}): LaunchFacts => ({
  status: "draft", steps: 4, leads: 1200, inboxes: 1272, unfilled: [], clientName: "Wagner Real Estate Group",
  excluded: false, dailyLimit: 1000, newLeadsPerDay: 500, ...over,
});
const stateOf = (f: LaunchFacts, key: string) => launchChecks(f).find((c) => c.key === key)!.state;

test("what the button does depends on the campaign's state", () => {
  assert.deepEqual(launchActionFor("draft"), { action: "launch", why: null });
  assert.deepEqual(launchActionFor(" Paused "), { action: "resume", why: null });
  assert.equal(launchActionFor("active").action, null);
  assert.match(launchActionFor("active").why!, /already sending/);
  assert.match(launchActionFor("queued").why!, /already queued/);
  assert.match(launchActionFor("completed").why!, /re-campaign/);
  assert.match(launchActionFor("archived").why!, /archived/);
  assert.equal(launchActionFor("something new").action, null);
});

test("a draft with a sequence, leads, inboxes, a client and limits can be launched", () => {
  const v = launchVerdict(ready());
  assert.equal(v.action, "launch");
  assert.equal(v.can, true);
  assert.equal(v.reason, null);
  assert.ok(v.checks.every((c) => c.state === "ok"));
});

test("each thing a campaign cannot send without stops the launch, by name", () => {
  for (const [over, word] of [
    [{ steps: 0 }, "sequence"], [{ leads: 0 }, "leads"], [{ inboxes: 0 }, "inboxes"],
  ] as const) {
    const v = launchVerdict(ready(over));
    assert.equal(v.can, false, word);
    assert.equal(v.reason, `Not ready: ${word}.`);
    assert.equal(v.action, "launch", "the action is still named, so the tab can say what is blocked");
  }
  assert.equal(launchVerdict(ready({ steps: 0, leads: 0 })).reason, "Not ready: sequence, leads.");
});

test("a client field still unfilled stops the launch", () => {
  const v = launchVerdict(ready({ unfilled: ["area"] }));
  assert.equal(v.can, false);
  assert.equal(stateOf(ready({ unfilled: ["area"] }), "client-fields"), "blocked");
  assert.match(v.checks.find((c) => c.key === "client-fields")!.detail, /\{CLIENT_AREA\}/);
});

test("anything that could not be read stops it too — never launched blind", () => {
  for (const over of [{ steps: null }, { leads: null }, { inboxes: null }, { unfilled: null }] as Partial<LaunchFacts>[]) {
    const v = launchVerdict(ready(over));
    assert.equal(v.can, false, JSON.stringify(over));
    assert.match(v.reason!, /could not be checked/);
  }
});

test("no client and no daily limit are said, and do not stop it", () => {
  const f = ready({ clientName: null, dailyLimit: null });
  assert.equal(stateOf(f, "client"), "warn");
  assert.equal(stateOf(f, "limits"), "warn");
  assert.equal(launchVerdict(f).can, true);
  assert.match(launchChecks(ready({ clientName: null, excluded: true })).find((c) => c.key === "client")!.detail, /^Excluded from client reporting/);
});

test("a paused campaign is resumed from here under the same checks", () => {
  assert.deepEqual([launchVerdict(ready({ status: "paused" })).action, launchVerdict(ready({ status: "paused" })).can], ["resume", true]);
  assert.equal(launchVerdict(ready({ status: "paused", inboxes: 0 })).can, false);
});

test("a campaign that is sending, finished or archived has nothing to launch — and says so before any check", () => {
  for (const status of ["active", "queued", "launching", "completed", "archived"]) {
    const v = launchVerdict(ready({ status, leads: 0 }));
    assert.equal(v.action, null, status);
    assert.equal(v.can, false);
    assert.doesNotMatch(v.reason!, /^Not ready/);
  }
});

test("counts read as English", () => {
  const detail = (key: string, over: Partial<LaunchFacts> = {}) => launchChecks(ready(over)).find((c) => c.key === key)!.detail;
  assert.equal(detail("inboxes"), "1,272 inboxes");
  assert.equal(detail("inboxes", { inboxes: 1 }), "1 inbox");
  assert.equal(detail("leads"), "1,200 leads");
  assert.equal(detail("sequence", { steps: 1 }), "1 step");
  assert.equal(detail("limits"), "1,000 emails a day · 500 new leads a day");
});

test("the confirm line says who it emails and how fast", () => {
  assert.equal(
    launchSummary(ready(), "launch"),
    "Launching queues this campaign to send to 1,200 leads from 1,272 inboxes at up to 1,000 emails a day. It cannot be undone — only paused.",
  );
  assert.equal(launchSummary(ready({ leads: 1, inboxes: 1, dailyLimit: null }), "resume"), "Resuming queues this campaign to send to 1 lead from 1 inbox. It cannot be undone — only paused.");
});
