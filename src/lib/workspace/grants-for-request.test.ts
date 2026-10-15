import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { analyticsScreenGrant, analyticsSectionLeaves, grantsForRequest, toolForPath } from "./tool-paths.ts";
import { NAV, products, type NavProduct } from "./nav.ts";

/*
 * The switches that open a request (15 Oct) — what the proxy enforces once
 * Campaign Analytics, Campaign Management and Inboxes have switches of their
 * own, and Clients, Commissions and Performance follow switches, not roles.
 *
 * Two failures matter, as for toolForPath:
 *   too loose   a section's data reachable without its switch
 *   too strict  someone locked out of a section they were given
 */

const has = (path: string, method: string, grant: string) => (grantsForRequest(path, method) ?? []).includes(grant as never);

test("each analytics screen needs its own section's switch", () => {
  const cases: Array<[string, string]> = [
    ["/analytics", "analytics"],
    ["/analytics/campaign", "analytics"],
    ["/analytics/volume", "analytics"],
    ["/analytics/infrastructure", "analytics"],
    ["/analytics/attribution", "analytics"],
    ["/analytics/copy-offer", "analytics"], // removed 9 Oct; opens Campaign
    ["/analytics/campaigns", "campaigns"],
    ["/analytics/campaigns/123", "campaigns"],
    ["/analytics/campaigns/123/leads", "campaigns"],
    ["/analytics/schedule", "campaigns"],
    ["/analytics/clients", "campaigns"],
    ["/analytics/client-view", "campaigns"],
    ["/analytics/inboxes", "inboxes"],
  ];
  for (const [p, grant] of cases) assert.deepEqual(grantsForRequest(p), [grant], p);
});

test("the sections' screens are exactly the menu's — a leaf added to the menu cannot slip past", () => {
  const leaves = analyticsSectionLeaves();
  const sections = products().filter((p) => p.id === "analytics");
  assert.equal(sections.length, 3, "Campaign Analytics, Campaign Management, Inboxes");
  for (const section of sections) {
    const grant = section.grant ?? section.id;
    for (const leaf of section.children) {
      assert.equal(leaves[leaf.id], grant, `${section.label} › ${leaf.label} must need ${grant}`);
      assert.equal(analyticsScreenGrant(leaf.id), grant);
    }
  }
  const menuLeaves = sections.flatMap((s) => s.children.map((c) => c.id)).sort();
  assert.deepEqual(Object.keys(leaves).sort(), menuLeaves, "no leaf in the rule that is not in the menu");
});

test("the menu shows each analytics section by its own switch", () => {
  const byKey = new Map(products().map((p: NavProduct) => [p.key ?? p.id, p.grant ?? p.id]));
  assert.equal(byKey.get("analytics"), "analytics");
  assert.equal(byKey.get("campaign-management"), "campaigns");
  assert.equal(byKey.get("inboxes"), "inboxes");
});

test("Inboxes' data needs the Inboxes switch — Campaign Analytics or Management alone does not open it", () => {
  for (const p of ["/api/tools/analytics/inboxes", "/api/tools/analytics/inboxes/extras"]) {
    assert.deepEqual(grantsForRequest(p, "GET"), ["inboxes"], p);
  }
});

test("reading campaign data: Campaign Analytics or Campaign Management; never Inboxes alone", () => {
  for (const fam of ["kpis", "timeseries", "campaign-rows", "client-rows", "replies", "volume", "infrastructure", "attribution", "filters", "schedule", "clients", "campaigns", "campaigns/123", "campaigns/123/inboxes", "campaigns/inboxes", "copy", "merge-tags", "outcomes", "reply-dimensions"]) {
    const p = `/api/tools/analytics/${fam}`;
    assert.deepEqual(grantsForRequest(p, "GET"), ["analytics", "campaigns"], p);
  }
});

test("the read-only sync status strip is on all three sections; a sync run needs Analytics or Management", () => {
  assert.deepEqual(grantsForRequest("/api/tools/analytics/sync/status", "GET"), ["analytics", "campaigns", "inboxes"]);
  assert.deepEqual(grantsForRequest("/api/tools/analytics/sync/run", "POST"), ["analytics", "campaigns"]);
});

test("changing a campaign needs Campaign Management — Campaign Analytics can look, not act", () => {
  const writes: Array<[string, string]> = [
    ["campaigns/123/launch", "POST"], ["campaigns/actions", "POST"], ["campaigns/123/sequence", "PUT"],
    ["campaigns/123/sequence/live", "POST"], ["campaigns/123/settings", "PATCH"], ["campaigns/inboxes", "POST"],
    ["campaigns/123/leads/remove", "POST"], ["campaigns/123/fan-out", "POST"], ["campaigns/123/copy-sequence", "POST"],
    ["campaigns/123/client", "PUT"], ["campaigns/123/re-campaign", "POST"], ["campaigns/123/unsupported-servers", "POST"],
    ["clients", "POST"], ["clients/9", "PATCH"], ["clients/9", "DELETE"], ["copy/tags", "PUT"],
  ];
  for (const [fam, method] of writes) {
    const p = `/api/tools/analytics/${fam}`;
    assert.deepEqual(grantsForRequest(p, method), ["campaigns"], `${method} ${p}`);
    assert.equal(has(p, method, "analytics"), false, `${method} ${p}: not with Campaign Analytics alone`);
  }
});

test("Campaign Analytics' own settings need Campaign Analytics", () => {
  assert.deepEqual(grantsForRequest("/api/tools/analytics/reply-dimensions", "PUT"), ["analytics"]);
  assert.deepEqual(grantsForRequest("/api/tools/analytics/outcomes", "POST"), ["analytics"]);
  assert.deepEqual(grantsForRequest("/api/tools/analytics/outcomes", "DELETE"), ["analytics"]);
});

test("every write route under the analytics API is classified (a new one fails here until it is)", () => {
  const root = path.join(process.cwd(), "src/app/api/tools/analytics");
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "route.ts") routes.push(full);
    }
  };
  walk(root);
  const known = new Set(["clients", "clients/[id]", "reply-dimensions", "outcomes", "copy/tags", "sync/run",
    "campaigns/[id]/settings", "campaigns/inboxes", "campaigns/[id]/unsupported-servers", "campaigns/[id]/launch",
    "campaigns/actions", "campaigns/[id]/leads/remove", "campaigns/[id]/sequence", "campaigns/[id]/fan-out",
    "campaigns/[id]/copy-sequence", "campaigns/[id]/sequence/live", "campaigns/[id]/client", "campaigns/[id]/re-campaign"]);
  for (const r of routes) {
    const src = fs.readFileSync(r, "utf8");
    if (!/export (async )?function (POST|PATCH|PUT|DELETE)|export const (POST|PATCH|PUT|DELETE)/.test(src)) continue;
    const rel = path.relative(root, path.dirname(r));
    assert.ok(known.has(rel), `write route ${rel} has no decided switch — add it to tool-paths.ts and this list`);
  }
});

test("Clients, Commissions and Performance are left to the page (nav.ts canSeePage, which knows roles) — not the proxy", () => {
  for (const p of ["/roster", "/commissions", "/performance", "/performance/billing"]) assert.equal(grantsForRequest(p), null, p);
});

test("everything else is exactly as before (toolForPath)", () => {
  for (const p of ["/", "/inbox/all-email", "/portals", "/clients", "/search", "/team", "/api/tools/master-inbox/threads", "/api/tools/client-health/x", "/api/workspace/home", "/api/workspace/clients/master", "/api/workspace/roster"]) {
    const t = toolForPath(p);
    assert.deepEqual(grantsForRequest(p), t ? [t] : null, p);
  }
});

test("the menu's Workspace pages are the ones with switches, plus Home", () => {
  const pages = NAV.find((s) => s.label === "Workspace")!.items.map((i) => i.id);
  assert.deepEqual(pages, ["home", "performance", "roster", "commissions"]);
});
