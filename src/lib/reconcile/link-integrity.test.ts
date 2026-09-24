/*
 * Link-integrity tests.
 *
 *   node --test src/lib/reconcile/link-integrity.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkLinks, type LinkClient, type ToolRows } from "./link-integrity.ts";

const rows = (pairs: [string, string][]): ToolRows => ({
  byId: new Map(pairs),
  idByName: new Map(pairs.map(([id, name]) => [name.toLowerCase().replace(/[^a-z0-9]/g, ""), id])),
});

const client = (over: Partial<LinkClient> = {}): LinkClient => ({
  name: "Oz Group",
  keys: ["ozgroup"],
  links: { analytics: "AN-1" },
  ...over,
});

test("a link that resolves and agrees with the name is sound and silent", () => {
  const r = checkLinks([client()], { analytics: rows([["AN-1", "Oz Group"]]) });
  assert.equal(r.findings.length, 0);
  assert.equal(r.sound, 1);
});

test("a STALE link is reported, and says the fallback is still covering it", () => {
  const r = checkLinks(
    [client({ links: { analytics: "AN-GONE" } })],
    { analytics: rows([["AN-1", "Oz Group"]]) },
  );
  assert.equal(r.findings[0].kind, "stale");
  assert.match(r.findings[0].detail, /no longer exists/);
  assert.match(r.findings[0].detail, /nothing looks broken yet/);
  assert.equal(r.sound, 0);
});

test("a stale link with no name fallback says so plainly", () => {
  const r = checkLinks(
    [client({ name: "Ghost", keys: ["ghost"], links: { analytics: "AN-GONE" } })],
    { analytics: rows([["AN-1", "Oz Group"]]) },
  );
  assert.equal(r.findings[0].kind, "stale");
  assert.match(r.findings[0].detail, /the name finds nothing either/);
});

test("id and name pointing at DIFFERENT rows is the worst kind, and sorts first", () => {
  const two = rows([["MI-BOS", "Properties & Estates Boston"], ["MI-FL", "Properties & Estates Florida"]]);
  const r = checkLinks(
    [
      client({ name: "Zed Co", keys: ["zedco"], links: { master_inbox: null } }),
      client({
        name: "Properties & Estates",
        keys: ["propertiesestates", "propertiesestatesflorida"],
        links: { master_inbox: "MI-BOS" },
      }),
    ],
    { master_inbox: two },
  );
  assert.equal(r.findings[0].kind, "disagrees", "disagreements rank above everything");
  assert.match(r.findings[0].detail, /Boston/);
  assert.match(r.findings[0].detail, /Florida/);
});

test("no link stored but the name finds a row -> unlinked, ranked last", () => {
  const r = checkLinks(
    [
      client({ name: "Stale Co", keys: ["staleco"], links: { analytics: "AN-GONE" } }),
      client({ name: "Oz Group", keys: ["ozgroup"], links: { analytics: null } }),
    ],
    { analytics: rows([["AN-1", "Oz Group"], ["AN-2", "Stale Co"]]) },
  );
  assert.equal(r.findings[0].kind, "stale");
  assert.equal(r.findings[1].kind, "unlinked");
  assert.match(r.findings[1].detail, /through a rename/);
});

test("no link and no row is not a finding — that is coverage's job", () => {
  const r = checkLinks(
    [client({ name: "Nowhere", keys: ["nowhere"], links: { analytics: null } })],
    { analytics: rows([["AN-1", "Oz Group"]]) },
  );
  assert.equal(r.findings.length, 0);
});

test("a tool whose rows carry no id is UNCHECKED, never reported as all-stale", () => {
  const noIds: ToolRows = { byId: new Map(), idByName: new Map([["ozgroup", ""]]) };
  const r = checkLinks([client({ links: { master_inbox: "MI-1" } })], { master_inbox: noIds });
  assert.equal(r.findings.length, 0);
  assert.deepEqual(r.unchecked, ["master_inbox"]);
});

test("an unreadable tool is unchecked, not assumed sound", () => {
  const r = checkLinks(
    [client()],
    { analytics: { byId: new Map(), idByName: new Map(), unreadable: true } },
  );
  assert.deepEqual(r.unchecked, ["analytics"]);
  assert.equal(r.sound, 0, "silence is not soundness");
});

test("each tool is judged on its own", () => {
  const r = checkLinks(
    [client({ links: { analytics: "AN-1", client_health: "CH-GONE" } })],
    {
      analytics: rows([["AN-1", "Oz Group"]]),
      client_health: rows([["CH-1", "Oz Group"]]),
    },
  );
  assert.equal(r.sound, 1, "Analytics is fine");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].tool, "client_health");
});
