/*
 * The notices for an introduction that reached its portal late (15 Oct):
 * sent once, only for entries migration 0078 created after the label, never
 * for anything older, never for the client's own candidates.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "./test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
delete process.env.OS_LATE_INTRO_NOTICES;
const db = new FakePostgrest();
let outboxRefuses = false;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (outboxRefuses && url.pathname.endsWith("/side_effect_outbox") && (init?.method ?? "GET").toUpperCase() === "POST") {
    return new Response(JSON.stringify({ code: "23514", message: 'violates check constraint "side_effect_outbox_kind_check"' }), { status: 400, headers: { "content-type": "application/json" } });
  }
  return db.fetch(input, init);
}) as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const { sweepLateIntroductions, isLateEntry } = await import("./late-introductions.ts");

const WS = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-16T12:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const sent: Array<[string, string[]]> = [];
const notices = {
  notify: async (ids: string[]) => { sent.push(["text and Bison", ids]); },
  slack: async (ids: string[]) => { sent.push(["Slack", ids]); },
  fub: async (ids: string[]) => { sent.push(["Follow Up Boss", ids]); },
};

function seed() {
  db.reset();
  sent.length = 0;
  outboxRefuses = false;
  db.seed("workspaces", [{ id: WS }]);
  const [intro] = db.seed("labels", [{ workspace_id: WS, name: "Introduction" }, { workspace_id: WS, name: "Interested" }]);
  const labelledLate = ago(3 * 60); // labelled three hours ago, client set five minutes ago
  db.seed("label_assignments", [
    { label_id: intro.id, target_type: "thread", target_id: "t-late", assigned_at: labelledLate },
    { label_id: intro.id, target_type: "thread", target_id: "t-normal", assigned_at: ago(5) },
    { label_id: intro.id, target_type: "thread", target_id: "t-client", assigned_at: labelledLate },
  ]);
  db.seed("client_pipeline_entries", [
    // Made by 0078 when the client was set: introduced = label time, created later.
    { client_id: "c1", thread_id: "t-late", source: "BrokerStaffer", introduced_at: labelledLate, created_at: ago(5) },
    // Made by the label trigger at labelling: created the same moment.
    { client_id: "c1", thread_id: "t-normal", source: "BrokerStaffer", introduced_at: ago(5), created_at: ago(5) },
    // The client's own candidate.
    { client_id: "c1", thread_id: "t-client", source: "Client Entry", introduced_at: labelledLate, created_at: ago(5) },
  ]);
  db.seed("side_effect_outbox", []);
}

test("an introduction that reached its portal late gets the three notices, once", async () => {
  seed();
  const r = await sweepLateIntroductions(NOW, { ws: WS, notices });
  assert.equal(r.notified, 1, JSON.stringify(r));
  assert.deepEqual(sent, [["text and Bison", ["t-late"]], ["Slack", ["t-late"]], ["Follow Up Boss", ["t-late"]]]);
  const [row] = db.rows("side_effect_outbox");
  assert.deepEqual([row.kind, row.subject_id, row.status], ["late_introduction", "t-late", "done"]);

  const again = await sweepLateIntroductions(new Date(NOW.getTime() + 60_000), { ws: WS, notices });
  assert.equal(again.notified, 0);
  assert.equal(sent.length, 3, "never twice");
});

test("a normal introduction (portal entry made at labelling) and the client's own candidates get nothing extra", async () => {
  seed();
  db.rows("client_pipeline_entries").splice(0, 1); // only t-normal and t-client left
  const r = await sweepLateIntroductions(NOW, { ws: WS, notices });
  assert.equal(r.seen, 0);
  assert.deepEqual(sent, []);
});

test("no backfill: nothing created before 15 Oct is ever notified", () => {
  assert.equal(isLateEntry({ created_at: "2026-10-14T23:00:00Z", introduced_at: "2026-08-13T19:21:00Z" }, "2026-08-13T19:21:00Z"), false);
  assert.equal(isLateEntry({ created_at: "2026-10-15T09:00:00Z", introduced_at: "2026-08-13T19:21:00Z" }, "2026-08-13T19:21:00Z"), true);
  // Not the label's time: some other way in, not 0078.
  assert.equal(isLateEntry({ created_at: "2026-10-16T09:00:00Z", introduced_at: "2026-10-16T08:00:00Z" }, "2026-10-16T07:00:00Z"), false);
  // Created within two minutes of the label: the label trigger, not late.
  assert.equal(isLateEntry({ created_at: "2026-10-16T09:01:00Z", introduced_at: "2026-10-16T09:00:00Z" }, "2026-10-16T09:00:00Z"), false);
});

test("one notice failing does not stop the others, and is not retried (no double sends)", async () => {
  seed();
  const r = await sweepLateIntroductions(NOW, { ws: WS, notices: { ...notices, slack: async () => { throw new Error("Slack down"); } } });
  assert.equal(r.notified, 1);
  assert.match(r.failed[0], /Slack: Slack down/);
  assert.deepEqual(sent.map((s) => s[0]), ["text and Bison", "Follow Up Boss"]);
  assert.equal(db.rows("side_effect_outbox")[0].status, "done");
});

test("before migration 0034 nothing is sent", async () => {
  seed();
  outboxRefuses = true;
  const r = await sweepLateIntroductions(NOW, { ws: WS, notices });
  assert.equal(r.off, "migration 0034 has not been run");
  assert.deepEqual(sent, []);
});

test("OS_LATE_INTRO_NOTICES=0 switches it off", async () => {
  seed();
  process.env.OS_LATE_INTRO_NOTICES = "0";
  try {
    assert.equal((await sweepLateIntroductions(NOW, { ws: WS, notices })).off, "OS_LATE_INTRO_NOTICES=0");
  } finally {
    delete process.env.OS_LATE_INTRO_NOTICES;
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(db.blocked, []);
});
