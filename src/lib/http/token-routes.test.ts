import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenRouteOpen } from "./token-routes.ts";

test("a token opens the Client Health roster for reading only", () => {
  assert.equal(tokenRouteOpen("/api/tools/client-health/clients", "GET", true), true);
  for (const m of ["POST", "PATCH", "DELETE", "PUT"]) {
    assert.equal(tokenRouteOpen("/api/tools/client-health/clients", m, true), false, m);
  }
});

test("the onboarding hook is POST only", () => {
  assert.equal(tokenRouteOpen("/api/tools/client-health/clients/onboard", "POST", true), true);
  assert.equal(tokenRouteOpen("/api/tools/client-health/clients/onboard", "GET", true), false);
});

test("the read feeds are GET only", () => {
  for (const p of ["/api/tools/client-health/clients/status", "/api/tools/client-health/metrics/weekly", "/api/workspace/clients/status-feed"]) {
    assert.equal(tokenRouteOpen(p, "get", true), true, p);
    assert.equal(tokenRouteOpen(p, "POST", true), false, p);
  }
});

test("no header, or an unlisted path, never opens", () => {
  assert.equal(tokenRouteOpen("/api/tools/client-health/clients", "GET", false), false);
  assert.equal(tokenRouteOpen("/api/tools/client-health/clients/campaigns", "GET", true), false);
  assert.equal(tokenRouteOpen("/api/tools/client-health/clients/", "GET", true), false);
});
