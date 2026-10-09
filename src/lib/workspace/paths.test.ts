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

import { destinations, idForPath, pathForId, sectionOf } from "./nav.ts";

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

test("Campaign Management's screens keep their /analytics addresses (9 Oct split)", () => {
  // Two rail sections share the analytics tool: every screen in the SECOND
  // one must still resolve to itself, not to Campaign Analytics' first screen.
  for (const leaf of ["campaigns", "schedule", "clients", "client-view"]) {
    assert.equal(idForPath(`/analytics/${leaf}`), `analytics:${leaf}`);
    assert.equal(pathForId(`analytics:${leaf}`), `/analytics/${leaf}`);
  }
  // One campaign's page lives under Campaigns.
  assert.equal(idForPath("/analytics/campaigns/1234"), "analytics:campaigns");
  const groups = Object.fromEntries(destinations().filter((d) => d.tool === "analytics").map((d) => [d.id, d.group]));
  assert.equal(groups["analytics:campaign"], "Campaign Analytics");
  assert.equal(groups["analytics:campaigns"], "Campaign Management");
});

test("the rail section of each screen (9 Oct split)", () => {
  assert.equal(sectionOf("analytics:campaign"), "analytics");
  assert.equal(sectionOf("analytics:attribution"), "analytics");
  assert.equal(sectionOf("analytics:campaigns"), "campaign-management");
  assert.equal(sectionOf("analytics:client-view"), "campaign-management");
  assert.equal(sectionOf("inbox:portals"), "inbox");
  assert.equal(sectionOf("home"), null);
});

test("removed screens' old links land somewhere useful (9 Oct)", () => {
  assert.equal(idForPath("/analytics/copy-offer"), "analytics:campaign", "Copy & Offer → Campaign");
  assert.equal(idForPath("/analytics/copy"), "analytics:campaign");
  assert.equal(idForPath("/clients/success"), "clients:weekly", "Client Success → Overview");
  assert.equal(idForPath("/search/master"), "search:search", "Master List → Search");
  for (const gone of ["clients:success", "search:master", "analytics:copy"]) {
    assert.equal(destinations().some((d) => d.id === gone), false, `${gone} is still in the menu`);
  }
});

test("Client Health's views are called Overview and Delivery, at their old addresses", () => {
  const label = (id: string) => destinations().find((d) => d.id === id)?.label;
  assert.equal(label("clients:weekly"), "Overview");
  assert.equal(label("clients:biweekly"), "Delivery");
  assert.equal(pathForId("clients:biweekly"), "/clients/biweekly");
});

test("every tool has its §8 Client view, addressed inside the tool", () => {
  for (const tool of ["inbox", "clients", "analytics", "onboarding", "search"]) {
    const id = `${tool}:client-view`;
    assert.equal(pathForId(id), `/${tool}/client-view`);
    assert.equal(idForPath(`/${tool}/client-view`), id);
  }
});
