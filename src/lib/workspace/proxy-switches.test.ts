/*
 * The proxy itself, with real signed sessions holding different switches
 * (15 Oct). Nothing here reaches a route handler: the proxy either lets a
 * request through (x-middleware-next) or refuses it, and that is all that is
 * asserted — so a write path can be tested without any write happening.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "test-secret-for-the-proxy-switch-tests";

const { mintSso } = await import("@/lib/bs-auth");
const { SWITCH_SPLIT_AT } = await import("./switch-transition.ts");
const { proxy } = await import("@/proxy");
const { NextRequest } = await import("next/server");

/* Signed after the split unless a test says otherwise — the switches, read as they are. */
async function as(grants: string[], path: string, method = "GET", signedAt = SWITCH_SPLIT_AT + 60_000) {
  const token = await mintSso(process.env.AUTH_SECRET!, { email: "teammate@brokerstaffer.com", grants: grants as never, ver: 1, now: signedAt, ttlMs: 24 * 3600_000 });
  const req = new NextRequest(new URL(path, "https://os.brokerstaffer.com"), { method, headers: { cookie: `bs_sso=${token}` } });
  const res = await proxy(req);
  if (res.headers.get("x-middleware-next") === "1") return "open";
  return res.status === 403 ? "refused" : res.headers.get("location")?.includes("/?denied=") ? "sent home" : `status ${res.status}`;
}

test("Inboxes only: the Inboxes page and its data — nothing of Campaign Analytics or Management", async () => {
  const g = ["inboxes"];
  assert.equal(await as(g, "/analytics/inboxes"), "open");
  assert.equal(await as(g, "/api/tools/analytics/inboxes"), "open");
  assert.equal(await as(g, "/api/tools/analytics/sync/status"), "open");
  assert.equal(await as(g, "/analytics"), "sent home");
  assert.equal(await as(g, "/analytics/campaigns"), "sent home");
  assert.equal(await as(g, "/api/tools/analytics/kpis"), "refused");
  assert.equal(await as(g, "/api/tools/analytics/campaigns/12/launch", "POST"), "refused");
});

test("Campaign Analytics only: can look at campaigns, cannot change one, cannot open Management or Inboxes", async () => {
  const g = ["analytics"];
  assert.equal(await as(g, "/analytics"), "open");
  assert.equal(await as(g, "/analytics/volume"), "open");
  assert.equal(await as(g, "/api/tools/analytics/kpis"), "open");
  assert.equal(await as(g, "/api/tools/analytics/sync/run", "POST"), "open");
  assert.equal(await as(g, "/api/tools/analytics/reply-dimensions", "PUT"), "open");
  assert.equal(await as(g, "/analytics/campaigns"), "sent home");
  assert.equal(await as(g, "/analytics/inboxes"), "sent home");
  assert.equal(await as(g, "/api/tools/analytics/inboxes"), "refused");
  for (const [p, m] of [["campaigns/12/launch", "POST"], ["campaigns/actions", "POST"], ["campaigns/12/sequence", "PUT"], ["campaigns/inboxes", "POST"], ["campaigns/12/leads/remove", "POST"], ["clients/3", "DELETE"]]) {
    assert.equal(await as(g, `/api/tools/analytics/${p}`, m), "refused", `${m} ${p}`);
  }
});

test("Campaign Management only: runs campaigns, reads what it needs, not Campaign Analytics' pages or Inboxes", async () => {
  const g = ["campaigns"];
  assert.equal(await as(g, "/analytics/campaigns"), "open");
  assert.equal(await as(g, "/analytics/campaigns/12"), "open");
  assert.equal(await as(g, "/analytics/schedule"), "open");
  assert.equal(await as(g, "/api/tools/analytics/campaigns/12"), "open");
  assert.equal(await as(g, "/api/tools/analytics/campaigns/12/launch", "POST"), "open");
  assert.equal(await as(g, "/api/tools/analytics/kpis"), "open", "the campaign figures it shows");
  assert.equal(await as(g, "/analytics"), "sent home");
  assert.equal(await as(g, "/analytics/inboxes"), "sent home");
  assert.equal(await as(g, "/api/tools/analytics/reply-dimensions", "PUT"), "refused");
});

test("Clients, Commissions, Performance are decided by the page, which knows roles (admin-pages.test.ts) — the proxy passes them through", async () => {
  for (const p of ["/roster", "/commissions", "/performance", "/performance/billing"]) assert.equal(await as(["inbox"], p), "open", p);
});

test("a session signed BEFORE the split keeps Campaign Management and Inboxes on its Campaign Analytics switch until it renews", async () => {
  const before = SWITCH_SPLIT_AT - 60_000;
  assert.equal(await as(["analytics"], "/analytics/campaigns", "GET", before), "open");
  assert.equal(await as(["analytics"], "/analytics/inboxes", "GET", before), "open");
  assert.equal(await as(["analytics"], "/api/tools/analytics/campaigns/12/launch", "POST", before), "open", "it could before the split");
  assert.equal(await as(["inbox"], "/analytics/campaigns", "GET", before), "sent home", "but never more than it had");
});

test("everyone who had a product before still has it (no product moved)", async () => {
  assert.equal(await as(["inbox"], "/inbox/all-email"), "open");
  assert.equal(await as(["portals"], "/portals"), "open");
  assert.equal(await as(["clients"], "/clients"), "open");
  assert.equal(await as(["search"], "/search"), "open");
  assert.equal(await as(["inbox"], "/portals"), "sent home");
});
