import assert from "node:assert/strict";
import { test } from "node:test";

import { classify, instantlyWord, isSending, nextHeld, type PlannedCampaign } from "./campaign-toggle.ts";

/*
 * The Play/Pause invariants (port document §6.4). The network calls are thin;
 * these decisions are what can pause a live client's campaigns wrongly.
 */

const c = (platform: "instantly" | "bison", id: string, status: string, int_id: number | null = null): PlannedCampaign => ({
  platform, id, int_id: platform === "bison" ? int_id ?? 1 : null, name: `${platform} ${id}`, status,
});

test("sending means Instantly active, or Bison active / queued / launching — nothing else", () => {
  assert.equal(instantlyWord(1), "active");
  assert.equal(instantlyWord(2), "paused");
  assert.equal(instantlyWord(3), "completed");
  assert.equal(instantlyWord(0), "draft");
  assert.equal(instantlyWord(null), "unknown");
  assert.ok(isSending(c("instantly", "a", "active")));
  for (const s of ["active", "queued", "launching"]) assert.ok(isSending(c("bison", "b", s)));
  for (const s of ["paused", "completed", "stopped", "draft", "failed"]) assert.ok(!isSending(c("bison", "b", s)));
  assert.ok(!isSending(c("instantly", "a", "queued")));
});

test("pause: the Keyes shape — 2 running Bison campaigns change, 7 are left alone with a reason", () => {
  const live = [
    c("bison", "west", "active", 11),
    c("bison", "east", "queued", 12),
    c("bison", "held", "paused", 13),
    ...Array.from({ length: 6 }, (_, i) => c("bison", `done${i}`, "completed", 20 + i)),
  ];
  const { willChange, skipped } = classify("pause", live);
  assert.deepEqual(willChange.map((x) => x.id), ["west", "east"]);
  assert.equal(skipped.length, 7);
  assert.equal(skipped.filter((s) => s.reason === "already paused").length, 1);
  assert.equal(skipped.filter((s) => s.reason === "finished — nothing left to send").length, 6);
});

test("pause skips draft, deleted and unreachable, each with its own reason", () => {
  const { willChange, skipped } = classify("pause", [
    c("instantly", "d", "draft"), c("instantly", "x", "deleted"), c("bison", "u", "unreachable"),
  ]);
  assert.equal(willChange.length, 0);
  assert.deepEqual(skipped.map((s) => s.reason), [
    "draft — has never sent", "no longer exists on the platform", "platform could not be reached",
  ]);
});

test("play resumes only what is paused now; running, finished and unreachable are skipped", () => {
  const { willChange, skipped } = classify("resume", [
    c("instantly", "p", "paused"), c("bison", "r", "active"), c("bison", "f", "completed"), c("instantly", "u", "unreachable"),
  ]);
  assert.deepEqual(willChange.map((x) => x.id), ["p"]);
  assert.deepEqual(skipped.map((s) => s.reason), [
    "already running", "finished since it was paused", "platform could not be reached",
  ]);
});

test("after pause, every success is appended once (by platform:id) with Bison's int id; failures are not held", () => {
  const prev = [{ platform: "bison" as const, id: "west", int_id: 11, name: "old", paused_at: "2026-09-01T00:00:00Z" }];
  const held = nextHeld(prev, "pause", { skipped: [] }, [
    { campaign: c("bison", "west", "active", 11), ok: true },
    { campaign: c("bison", "east", "active", 12), ok: true },
    { campaign: c("instantly", "i", "active"), ok: false, error: "Instantly 500" },
  ], "2026-09-29T10:00:00Z");
  assert.equal(held.length, 2);
  assert.deepEqual(held.map((h) => [h.id, h.int_id]), [["west", 11], ["east", 12]]);
  assert.equal(held[1].paused_at, "2026-09-29T10:00:00Z");
});

test("after play, resumed and no-longer-resumable entries are released; unreachable and failed stay held", () => {
  const h = (platform: "instantly" | "bison", id: string) => ({ platform, id, int_id: null, name: id, paused_at: "x" });
  const held = nextHeld(
    [h("instantly", "ok"), h("instantly", "fail"), h("bison", "running"), h("bison", "gone"), h("bison", "far")],
    "resume",
    { skipped: [
      { campaign: c("bison", "running", "active"), reason: "already running" },
      { campaign: c("bison", "gone", "deleted"), reason: "no longer exists on the platform" },
      { campaign: c("bison", "far", "unreachable"), reason: "platform could not be reached" },
    ] },
    [
      { campaign: c("instantly", "ok", "paused"), ok: true },
      { campaign: c("instantly", "fail", "paused"), ok: false, error: "boom" },
    ],
    "now",
  );
  assert.deepEqual(held.map((x) => x.id).sort(), ["fail", "far"]);
});
