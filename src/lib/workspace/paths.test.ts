/*
 * URL ↔ screen mapping.
 *
 * These addresses are the visible surface of "one product" — `/inbox` and
 * `/analytics` under one host is the whole point. Two properties matter:
 *
 *   every screen must round-trip, or a link goes somewhere else than it says
 *   an unknown path must degrade to something useful, never a blank pane
 *
 *   node --test src/lib/workspace/paths.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { destinations, idForPath, pathForId } from "./nav.ts";

test("every destination round-trips through its URL", () => {
  // The one that matters: a link in Slack must open the screen it names.
  for (const d of destinations()) {
    const path = pathForId(d.id);
    assert.equal(
      idForPath(path),
      d.id,
      `${d.id} → ${path} → ${idForPath(path)}`,
    );
  }
});

test("the addresses are the short, readable ones", () => {
  assert.equal(pathForId("home"), "/");
  assert.equal(pathForId("performance"), "/performance");
  assert.equal(pathForId("team-access"), "/team");
  assert.equal(pathForId("inbox:all-email"), "/inbox");
  assert.equal(pathForId("clients:weekly"), "/clients");
  assert.equal(pathForId("analytics:campaign"), "/analytics");
  assert.equal(pathForId("onboarding:pipeline"), "/onboarding");
});

test("a product's first screen is its bare path", () => {
  // /inbox rather than /inbox/all-email — the short form is the one people
  // will type and share.
  assert.equal(pathForId("inbox:all-email"), "/inbox");
  assert.equal(pathForId("inbox:reminders"), "/inbox/reminders");
});

test("a bare product path opens its first screen", () => {
  assert.equal(idForPath("/inbox"), "inbox:all-email");
  assert.equal(idForPath("/analytics"), "analytics:campaign");
  assert.equal(idForPath("/onboarding"), "onboarding:pipeline");
});

test("trailing slashes and empty segments are tolerated", () => {
  assert.equal(idForPath("/inbox/"), "inbox:all-email");
  assert.equal(idForPath("//inbox//reminders//"), "inbox:reminders");
  assert.equal(idForPath("/"), "home");
  assert.equal(idForPath(""), "home");
});

test("an unknown product falls back to Home", () => {
  assert.equal(idForPath("/nonsense"), "home");
  assert.equal(idForPath("/database"), "home", "a removed tool must not open a blank pane");
});

test("an unknown screen within a real product opens that product", () => {
  // A stale link — a screen that was renamed — should land on the tool rather
  // than nothing at all.
  assert.equal(idForPath("/inbox/deleted-screen"), "inbox:all-email");
  assert.equal(idForPath("/analytics/old-tab"), "analytics:campaign");
});

test("no two destinations share an address", () => {
  // A collision would make one screen unreachable by link, silently.
  const paths = destinations().map((d) => pathForId(d.id));
  assert.equal(new Set(paths).size, paths.length, `duplicate: ${paths.join(", ")}`);
});

test("the tool's own hostname never appears in an address", () => {
  // These are paths on the workspace, not links out to a tool. If one ever
  // became absolute, the address bar would leave the workspace and the
  // "one product" illusion would break in the most visible way possible.
  for (const d of destinations()) {
    const path = pathForId(d.id);
    assert.ok(path.startsWith("/"), `${d.id} produced ${path}`);
    assert.equal(/^https?:/.test(path), false, `${d.id} produced an absolute URL`);
  }
});
