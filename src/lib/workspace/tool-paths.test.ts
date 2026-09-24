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
    ["/onboarding/pipeline", "onboarding"],
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
