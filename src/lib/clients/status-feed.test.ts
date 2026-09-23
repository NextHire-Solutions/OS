import assert from "node:assert/strict";
import { test } from "node:test";

import { buildStatusFeed } from "./status-feed";

/*
 * These tests guard one thing above all: a client whose portal is open must
 * never be closed by this feed as a side effect of how we spell a status.
 */

test("emits the three statuses a consumer understands", () => {
  const feed = buildStatusFeed([
    { id: "1", name: "A", status: "active" },
    { id: "2", name: "B", status: "paused" },
    { id: "3", name: "C", status: "churned" },
  ]);
  assert.deepEqual(
    feed.clients.map((c) => [c.name, c.status]),
    [
      ["A", "active"],
      ["B", "paused"],
      ["C", "churned"],
    ],
  );
  assert.deepEqual(feed.counts, { active: 1, paused: 1, churned: 1 });
  assert.equal(feed.total, 3);
  assert.equal(feed.omitted.length, 0);
});

test("onboarding is omitted, never downgraded to a portal-closing status", () => {
  for (const spelling of ["onboarding", "prospect"]) {
    const feed = buildStatusFeed([{ id: "1", name: "New Co", status: spelling }]);
    assert.equal(feed.clients.length, 0, `${spelling} must not appear in the feed`);
    assert.equal(feed.total, 0);
    assert.equal(feed.omitted[0].reason, "still onboarding — left untouched on purpose");
    // The point of omitting: a consumer that ignores absent clients leaves the
    // portal exactly as a person set it.
    assert.ok(!feed.clients.some((c) => c.status !== "active"));
  }
});

test("an unknown status is omitted rather than guessed at", () => {
  const feed = buildStatusFeed([
    { id: "1", name: "Odd", status: "on hold" },
    { id: "2", name: "Fine", status: "active" },
  ]);
  assert.deepEqual(feed.clients.map((c) => c.name), ["Fine"]);
  assert.equal(feed.omitted[0].status, "on hold");
});

test("a nameless row is omitted — nothing could match it anyway", () => {
  const feed = buildStatusFeed([
    { id: "1", name: "   ", status: "churned" },
    { id: "2", name: "Real", status: "churned" },
  ]);
  assert.deepEqual(feed.clients.map((c) => c.name), ["Real"]);
  assert.equal(feed.omitted[0].reason, "no name");
});

test("names are trimmed, because the consumer matches on the name", () => {
  const feed = buildStatusFeed([{ id: "1", name: "  Spaced Co  ", status: "active" }]);
  assert.equal(feed.clients[0].name, "Spaced Co");
});

test("counts only ever describe what was actually emitted", () => {
  const feed = buildStatusFeed([
    { id: "1", name: "A", status: "active" },
    { id: "2", name: "B", status: "onboarding" },
    { id: "3", name: "C", status: "active" },
  ]);
  assert.equal(feed.counts.active + feed.counts.paused + feed.counts.churned, feed.total);
  assert.equal(feed.total, 2);
});

test("an empty roster produces an empty feed, not a crash", () => {
  const feed = buildStatusFeed([]);
  assert.deepEqual(feed, {
    total: 0,
    counts: { active: 0, paused: 0, churned: 0 },
    clients: [],
    omitted: [],
  });
});
