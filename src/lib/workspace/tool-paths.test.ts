import { test } from "node:test";
import assert from "node:assert/strict";

import { toolForPath } from "./tool-paths.ts";

/*
 * The access-control mapping.
 *
 * This is the table that decides whether a user granted one tool can read
 * another's data. It was missing entirely until 2026-09-14, and the symptom
 * was silent: the sidebar hid the other tools and every one of their URLs
 * still worked.
 *
 * Two failures matter and both are pinned below:
 *
 *   too loose   a tool path that maps to null is ungated — the original bug
 *   too strict  a granted user locked out of their own tool
 */

test("every screen prefix maps to its tool", () => {
  const cases: Array<[string, string]> = [
    ["/inbox/all-email", "inbox"],
    ["/inbox/settings/labels", "inbox"],
    ["/clients", "clients"],
    ["/clients/biweekly", "clients"],
    ["/analytics/campaign", "analytics"],
    ["/analytics/campaigns", "analytics"],
    ["/search/search", "search"],
    ["/search/mls", "search"],
  ];
  for (const [path, tool] of cases) assert.equal(toolForPath(path), tool, path);
});

test("API segments map to their tool, and they are NOT the screen names", () => {
  /*
   * The trap this pins: the API is `/api/tools/master-inbox/*` while the
   * screen is `/inbox/*`, and `/api/tools/agent-search/*` while the screen is
   * `/search/*`. A mapping written from the screen names alone would leave
   * both of those ungated — and those are the routes carrying the data.
   */
  const cases: Array<[string, string]> = [
    ["/api/tools/master-inbox/threads", "inbox"],
    ["/api/tools/master-inbox/clients/portals", "inbox"],
    ["/api/tools/client-health/clients", "clients"],
    ["/api/tools/analytics/clients", "analytics"],
    ["/api/tools/analytics/campaigns/12/sequence", "analytics"],
    ["/api/tools/onboarding/stages", "onboarding"],
    ["/api/tools/agent-search/status", "search"],
    // The Database view's data: gated with its screen, /search/clients.
    ["/api/tools/agent-search/clients", "search"],
    ["/search/clients", "search"],
  ];
  for (const [path, tool] of cases) assert.equal(toolForPath(path), tool, path);
});

test("the workspace's own surfaces are not tool-gated", () => {
  // These aggregate across tools and belong to the workspace itself. They are
  // reachable by any signed-in user; see the note in proxy.ts.
  for (const path of [
    "/", "/performance", "/roster", "/consistency", "/admin/team",
    "/api/workspace/roster", "/api/workspace/home", "/api/health", "/login",
    // Consistency reads every tool's client list to compare them, so it is a
    // workspace surface like the roster rather than any one tool's page.
    "/api/reconcile/clients",
  ]) {
    assert.equal(toolForPath(path), null, path);
  }
});

test("an unknown path is not silently attributed to a tool", () => {
  for (const path of ["/nonsense", "/api/tools", "/api/tools/", "/api/nope/analytics"]) {
    assert.equal(toolForPath(path), null, path);
  }
});

test("a prefix must match a whole segment, not a substring", () => {
  // "/searchlight" must not be read as the Agent Search tool, and
  // "/clientsomething" must not be read as Client Health.
  assert.equal(toolForPath("/searchlight"), null);
  assert.equal(toolForPath("/clientsomething"), null);
  assert.equal(toolForPath("/inboxes"), null);
});

test("trailing slashes and query-free paths behave the same", () => {
  assert.equal(toolForPath("/analytics/campaign/"), "analytics");
  assert.equal(toolForPath("/clients/"), "clients");
});

test("removed Onboarding screens are not gated — an old link opens Home; its API still is (9 Oct)", () => {
  assert.equal(toolForPath("/onboarding/pipeline"), null);
  assert.equal(toolForPath("/onboarding"), null);
  assert.equal(toolForPath("/api/tools/onboarding/stages"), "onboarding");
});

test("Client Portals is guarded by its own grant — screens, old addresses and its routes (13 Oct)", () => {
  const id = "0b4c2a3e-0000-4000-8000-000000000000";
  // Screens.
  assert.equal(toolForPath("/portals"), "portals");
  assert.equal(toolForPath(`/portals/${id}`), "portals");
  assert.equal(toolForPath("/portals/client-view"), "portals");
  // The old addresses redirect to the new ones, so they carry the new grant:
  // someone with Client Portals and not Master Inbox must not be refused on a
  // bookmark, and someone with only Master Inbox must not get in through one.
  assert.equal(toolForPath("/inbox/portals"), "portals");
  assert.equal(toolForPath(`/inbox/portals/${id}`), "portals");
  assert.equal(toolForPath("/inbox/client-view"), "portals");

  // Its routes still live under /api/tools/master-inbox.
  for (const path of [
    "/api/tools/master-inbox/portals",
    "/api/tools/master-inbox/portal/some-token-abc123/pipeline",
    "/api/tools/master-inbox/portal/some-token-abc123/pipeline/42/notes",
    "/api/tools/master-inbox/portal/some-token-abc123/stages",
    `/api/tools/master-inbox/clients/${id}`,
    `/api/tools/master-inbox/clients/${id}/delete-plan`,
  ]) {
    assert.equal(toolForPath(path), "portals", path);
  }
});

test("splitting Client Portals out takes nothing from Master Inbox (13 Oct)", () => {
  // Every one of these is called by an inbox screen or a token-authenticated
  // feed. Gating any of them on `portals` would break the inbox for someone
  // who holds Master Inbox only — which, from 13 Oct, is everyone but admins.
  for (const path of [
    "/inbox",
    "/inbox/archive",
    "/inbox/settings",
    "/inbox/reminders",
    "/api/tools/master-inbox/clients",
    "/api/tools/master-inbox/clients/status",
    "/api/tools/master-inbox/clients/intro-stats",
    "/api/tools/master-inbox/clients/intros",
    "/api/tools/master-inbox/clients/portals",
    "/api/tools/master-inbox/threads",
    "/api/tools/master-inbox/lists",
    "/api/tools/master-inbox/webhooks/emailbison",
  ]) {
    assert.equal(toolForPath(path), "inbox", path);
  }
  // A look-alike is not a portal route: only a UUID after /clients is.
  assert.equal(toolForPath("/api/tools/master-inbox/portalsx"), "inbox");
  assert.equal(toolForPath("/api/tools/master-inbox/clients/not-a-uuid"), "inbox");
});
