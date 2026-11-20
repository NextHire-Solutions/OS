/*
 * A hand-off that went is labelled Introduction (20 Nov). The rule of when, and the REAL label call against the
 * in-memory database: the conversation ends up labelled Introduction only, the introduction announcement is queued
 * once, and a second call announces nothing. Nothing here can reach a real service.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { introduceDecision, INTRO_ALERT_WAIT_MS } = await import("./handoff-introduction.ts");
const { labelIntroduction } = await import("./handoff-introduction-io.ts");

test("when to label: Interested still on, the Interested alert has had its turn", () => {
  assert.equal(introduceDecision({ labels: ["Interested"], alertSettled: true, waitedMs: 0 }), "label");
  assert.equal(introduceDecision({ labels: ["Meetings Booked"], alertSettled: true, waitedMs: 0 }), "label");
});

test("waits for the Interested alert, but never longer than the limit", () => {
  assert.equal(introduceDecision({ labels: ["Interested"], alertSettled: false, waitedMs: 60_000 }), "wait");
  assert.equal(introduceDecision({ labels: ["Interested"], alertSettled: false, waitedMs: INTRO_ALERT_WAIT_MS - 1 }), "wait");
  assert.equal(introduceDecision({ labels: ["Interested"], alertSettled: false, waitedMs: INTRO_ALERT_WAIT_MS }), "label");
  assert.equal(INTRO_ALERT_WAIT_MS, 10 * 60_000);
});

test("already Introduction (a person introduced it): nothing to do, nothing announced again", () => {
  assert.equal(introduceDecision({ labels: ["Introduction"], alertSettled: false, waitedMs: 0 }), "already");
  assert.equal(introduceDecision({ labels: [" introduction "], alertSettled: true, waitedMs: 0 }), "already");
});

test("relabelled by a person since, or its label taken off: their call stands", () => {
  for (const l of [["Not Interested"], ["Do Not Contact"], ["Keep Warm"], ["Unsubscribe"], []]) {
    assert.equal(introduceDecision({ labels: l, alertSettled: true, waitedMs: 0 }), "relabelled", JSON.stringify(l));
  }
});

const WS = "00000000-0000-4000-8000-000000000001";
function seed() {
  db.reset();
  db.seed("workspaces", [{ id: WS, name: "BrokerStaffer" }]);
  const [interested, introduction] = db.seed("labels", [{ workspace_id: WS, name: "Interested" }, { workspace_id: WS, name: "Introduction" }]);
  const [client] = db.seed("clients", [{ name: "Carolina Realty Advisors", slug: "cra" }]);
  const [lead] = db.seed("leads", [{ workspace_id: WS, full_name: "David Kerner", email: "david@agent.test", company: "Touchpoint" }]);
  const [thread] = db.seed("threads", [{ workspace_id: WS, client_id: client.id, lead_id: lead.id, subject: "Re: David?", campaign_name: "Carolina Realty Advisors + Charlotte + ZF NS1 (EST)" }]);
  db.seed("label_assignments", [{ workspace_id: WS, label_id: interested.id, target_type: "thread", target_id: thread.id, assigned_by: "ai", assigned_at: new Date().toISOString() }]);
  db.seed("side_effect_outbox", []);
  db.seed("client_pipeline_entries", []);
  db.seed("client_pipeline_notes", []);
  return { thread, interested, introduction };
}

test("the real label call: Introduction replaces Interested, the announcement is queued once, and a second call is silent", async () => {
  const { thread, introduction } = seed();
  const r = await labelIntroduction(WS, thread.id);
  assert.deepEqual(r, { ok: true, announced: true });
  const onThread = db.rows("label_assignments").filter((a) => a.target_id === thread.id);
  assert.deepEqual(onThread.map((a) => [a.label_id, a.assigned_by]), [[introduction.id, "system"]], "one label: Introduction, by the system");
  const queued = db.rows("side_effect_outbox").filter((o) => o.subject_id === thread.id).map((o) => String(o.kind));
  assert.ok(queued.length > 0, `the introduction announcement is queued (${queued.join(", ")})`);
  const again = await labelIntroduction(WS, thread.id);
  assert.deepEqual(again, { ok: true, announced: false }, "already carried: never announced twice");
  assert.equal(db.rows("side_effect_outbox").filter((o) => o.subject_id === thread.id).length, queued.length, "nothing queued again");
});

test("no Introduction label in the workspace: refused with the reason, nothing written", async () => {
  const { thread } = seed();
  db.seed("labels", db.rows("labels").filter((l) => l.name !== "Introduction"));
  const before = db.rows("label_assignments").length;
  const r = await labelIntroduction(WS, thread.id);
  assert.deepEqual(r, { ok: false, error: "there is no Introduction label in this workspace" });
  assert.equal(db.rows("label_assignments").length, before);
});
