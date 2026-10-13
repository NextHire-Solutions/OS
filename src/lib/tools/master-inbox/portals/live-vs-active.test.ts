/*
 * Live portals against active clients (13 Oct: "Live portals should match the
 * list of active clients"). The real data on that day is the first test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isDemoOrTest, liveVsActive, matchLine, type ActiveClientRef, type PortalRef } from "./live-vs-active.ts";

const portal = (name: string, live: boolean, client: [string, string, string] | null): PortalRef => ({
  name, live, clientId: client?.[0] ?? null, clientName: client?.[1] ?? null, clientStatus: client?.[2] ?? null,
});
const PE: [string, string, string] = ["c-pe", "Properties & Estates", "active"];
const ACME: [string, string, string] = ["c-acme", "Acme", "active"];
const OLD: [string, string, string] = ["c-old", "Old Co", "churned"];
const NAP: [string, string, string] = ["c-nap", "Nap Realty", "paused"];
const active = (...c: Array<[string, string, string]>): ActiveClientRef[] => c.map(([id, name]) => ({ id, name }));

test("13 Oct: 29 client portals live for 28 active clients, because one client has two — and that is a match", () => {
  const portals = [
    portal("Properties & Estates Boston", true, PE), portal("Properties & Estates Florida", true, PE),
    portal("Acme", true, ACME), portal("Old Co", false, OLD), portal("Nap Realty", false, NAP),
    portal("Demo Portal", true, null),
  ];
  const v = liveVsActive(portals, active(PE, ACME));
  assert.equal(v.matches, true);
  assert.equal(v.livePortals, 3, "the demo portal is not counted");
  assert.equal(v.activeClients, 2);
  assert.deepEqual(v.several, [{ client: "Properties & Estates", portals: ["Properties & Estates Boston", "Properties & Estates Florida"] }]);
  assert.equal(matchLine(v), "Live portals match active clients: every one of the 2 active clients has a live portal, and no paused or churned client does. 3 live for 2 active clients because Properties & Estates has 2.");
});

test("the demo portal is listed apart: live or not, it is never a mismatch", () => {
  assert.equal(isDemoOrTest(portal("Demo Portal", true, null)), true);
  assert.equal(isDemoOrTest(portal("Acme", true, ACME)), false);
  for (const live of [true, false]) {
    const v = liveVsActive([portal("Acme", true, ACME), portal("Demo Portal", live, null)], active(ACME));
    assert.equal(v.matches, true);
    assert.equal(v.livePortals, 1);
  }
});

test("a paused or churned client with a live portal is named", () => {
  const v = liveVsActive([portal("Acme", true, ACME), portal("Old Co", true, OLD), portal("Nap Realty", true, NAP)], active(ACME));
  assert.equal(v.matches, false);
  assert.deepEqual(v.liveNotActive, [
    { portal: "Nap Realty", client: "Nap Realty", status: "paused" },
    { portal: "Old Co", client: "Old Co", status: "churned" },
  ]);
  assert.match(matchLine(v), /^Live portals do not match active clients — 2 portals are live for a client that is not active: Nap Realty \(paused\) and Old Co \(churned\)\.$/);
});

test("an active client with its portal off, or with none at all, is named", () => {
  const v = liveVsActive([portal("Acme", false, ACME), portal("Properties & Estates Boston", true, PE)], active(ACME, PE, ["c-new", "New Client", "active"]));
  assert.equal(v.matches, false);
  assert.deepEqual(v.activeNotLive, [{ client: "Acme", portals: ["Acme"] }, { client: "New Client", portals: [] }]);
  assert.match(matchLine(v), /2 active clients have no live portal: Acme and New Client\./);
});

test("one live portal of two is enough for the client to count as having one", () => {
  const v = liveVsActive([portal("Properties & Estates Boston", true, PE), portal("Properties & Estates Florida", false, PE)], active(PE));
  assert.equal(v.matches, true);
  assert.deepEqual(v.several, []);
  assert.equal(matchLine(v), "Live portals match active clients: every one of the 1 active client has a live portal, and no paused or churned client does.");
});

test("both kinds of mismatch are reported together", () => {
  const v = liveVsActive([portal("Old Co", true, OLD), portal("Acme", false, ACME)], active(ACME));
  assert.match(matchLine(v), /1 portal is live for a client that is not active: Old Co \(churned\); 1 active client has no live portal: Acme\./);
});

test("nothing at all is not an error", () => {
  assert.equal(matchLine(liveVsActive([], [])), "No active clients and no live portals.");
});
