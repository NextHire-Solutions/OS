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
    entries: 0,
    omitted: [],
  });
});

/* =========================================================================
 * ONE CLIENT, MANY PORTALS
 *
 * MasterInbox holds one row per PORTAL and matches on the name. These are the
 * two real shapes in production, and the bug they exposed: the master name
 * matched no portal at all, so those portals ignored the client's status.
 * ========================================================================= */

test("every alias is emitted too, so each portal can be matched", () => {
  const feed = buildStatusFeed([
    {
      id: "pe",
      name: "Properties & Estates",
      status: "active",
      aliases: ["Properties & Estates Florida", "Properties & Estates Boston"],
    },
  ]);
  assert.deepEqual(feed.clients.map((c) => c.name), [
    "Properties & Estates",
    "Properties & Estates Florida",
    "Properties & Estates Boston",
  ]);
  // Every entry is the SAME client: same id, same status.
  assert.ok(feed.clients.every((c) => c.id === "pe" && c.status === "active"));
  assert.deepEqual(feed.clients.map((c) => c.via), ["name", "alias", "alias"]);
});

test("a client with several portals still counts as ONE client", () => {
  const feed = buildStatusFeed([
    { id: "pe", name: "Properties & Estates", status: "active", aliases: ["P&E Florida", "P&E Boston"] },
    { id: "s", name: "SERHANT. PA", status: "active", aliases: ["SERHANT. PA 15M+"] },
  ]);
  // This is the requirement: two clients, five portal names.
  assert.equal(feed.total, 2, "total counts CLIENTS");
  assert.equal(feed.entries, 5, "entries counts the names a consumer can match");
  assert.deepEqual(feed.counts, { active: 2, paused: 0, churned: 0 });
});

test("pausing a client turns off EVERY portal it has", () => {
  const feed = buildStatusFeed([
    {
      id: "pe",
      name: "Properties & Estates",
      status: "paused",
      aliases: ["Properties & Estates Florida", "Properties & Estates Boston"],
    },
  ]);
  // MasterInbox reads anything that is not "active" as portal OFF. All three
  // names must carry the paused status or a portal stays open after a pause.
  assert.equal(feed.clients.length, 3);
  assert.ok(feed.clients.every((c) => c.status === "paused"));
});

test("churning a client reaches every portal too", () => {
  const feed = buildStatusFeed([
    { id: "s", name: "SERHANT. PA", status: "churned", aliases: ["SERHANT. PA 15M+"] },
  ]);
  assert.deepEqual(
    feed.clients.map((c) => [c.name, c.status]),
    [
      ["SERHANT. PA", "churned"],
      ["SERHANT. PA 15M+", "churned"],
    ],
  );
});

test("an alias that is the primary name once normalised is not emitted twice", () => {
  const feed = buildStatusFeed([
    { id: "1", name: "RE/MAX Pacific", status: "active", aliases: ["REMAX Pacific"] },
  ]);
  // Both normalise to "remaxpacific" — one entry is enough to match the portal,
  // and two would just be noise.
  assert.equal(feed.clients.length, 1);
  assert.equal(feed.entries, 1);
  assert.equal(feed.total, 1);
});

test("an onboarding client's aliases are omitted along with it", () => {
  const feed = buildStatusFeed([
    { id: "1", name: "New Co", status: "onboarding", aliases: ["New Co West", "New Co East"] },
  ]);
  // Onboarding means "leave every portal exactly as it is" — that has to apply
  // to the client's other portals as well, not just the primary one.
  assert.equal(feed.clients.length, 0);
  assert.equal(feed.entries, 0);
});

/* ---- ambiguity is dropped, never guessed ---- */

test("an alias colliding with a real client's name loses — the real name wins", () => {
  const feed = buildStatusFeed([
    { id: "real", name: "Spotlight", status: "active" },
    { id: "other", name: "Spotlight - A Compass Team", status: "churned", aliases: ["Spotlight"] },
  ]);
  const spotlight = feed.clients.filter((c) => c.name === "Spotlight");
  assert.equal(spotlight.length, 1);
  assert.equal(spotlight[0].id, "real", "the client actually named Spotlight keeps the name");
  assert.equal(spotlight[0].status, "active");
  // And the loss is explained rather than silent — otherwise a live portal
  // would flip to churned with no trace of why.
  assert.match(feed.omitted[0].reason, /the real name wins/);
});

test("two clients sharing a normalised name are both dropped, not guessed", () => {
  const feed = buildStatusFeed([
    { id: "1", name: "Acme Realty", status: "active" },
    { id: "2", name: "acme-realty", status: "churned" },
  ]);
  assert.equal(feed.clients.length, 1, "the first wins the name");
  assert.equal(feed.total, 1);
  assert.match(feed.omitted[0].reason, /collides/);
});

test("two clients whose aliases collide keep their own names and lose the alias", () => {
  const feed = buildStatusFeed([
    { id: "1", name: "North Group", status: "active", aliases: ["NG Team"] },
    { id: "2", name: "South Group", status: "churned", aliases: ["N.G. Team"] },
  ]);
  assert.deepEqual(feed.clients.map((c) => c.name), ["North Group", "South Group", "NG Team"]);
  assert.equal(feed.total, 2);
  assert.match(feed.omitted[0].reason, /alias of another client/);
});

test("a blank or punctuation-only alias is skipped quietly", () => {
  const feed = buildStatusFeed([
    { id: "1", name: "A Co", status: "active", aliases: ["", "   ", "---"] },
  ]);
  assert.equal(feed.clients.length, 1);
  assert.equal(feed.omitted.length, 0);
});

test("aliases absent or null behave exactly as before", () => {
  for (const aliases of [undefined, null, []]) {
    const feed = buildStatusFeed([{ id: "1", name: "A", status: "active", aliases }]);
    assert.equal(feed.clients.length, 1);
    assert.equal(feed.total, 1);
    assert.equal(feed.entries, 1);
  }
});
