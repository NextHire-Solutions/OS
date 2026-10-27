/*
 * Who may open which portal in the new design (viewer-rules.ts, 27 Oct). Run with
 * node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs --test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEMO_PORTAL_ID } from "./demo.ts";
import { clientPortals, guardRole, mayOpenPortal, openToClients, type CrmViewer } from "./viewer-rules.ts";

const REAL = "6b787a4c-22e1-4ba7-96e2-f7a4f3eaf849";
const OTHER = "492b2783-280f-4c6d-8807-a3de56c59ab1";

test("until the user says to switch, only the Demo Portal is open to clients", () => {
  assert.equal(openToClients(DEMO_PORTAL_ID), true);
  for (const id of [REAL, OTHER, "", null, undefined]) assert.equal(openToClients(id), false, String(id));
  assert.deepEqual(clientPortals([REAL, DEMO_PORTAL_ID, OTHER, DEMO_PORTAL_ID]), [DEMO_PORTAL_ID], "a real client on the list still sees only the Demo");
  assert.deepEqual(clientPortals([REAL, OTHER]), [], "a real client: nothing here — their current portal, as before");
});

test("staff open any portal; a client only their own, and only one open to clients", () => {
  const staff: CrmViewer = { kind: "staff", email: "admin@outreachify.io" };
  for (const id of [REAL, OTHER, DEMO_PORTAL_ID]) assert.equal(mayOpenPortal(staff, id), true, id);
  const client: CrmViewer = { kind: "client", email: "someone@client.test", portals: [DEMO_PORTAL_ID] };
  assert.equal(mayOpenPortal(client, DEMO_PORTAL_ID), true);
  assert.equal(mayOpenPortal(client, REAL), false, "not theirs");
  // Even listed for a real portal (a forged or stale list), a real portal stays closed.
  const listed: CrmViewer = { kind: "client", email: "someone@client.test", portals: [REAL] };
  assert.equal(mayOpenPortal(listed, REAL), false, "not open to clients yet");
  assert.equal(mayOpenPortal(null, DEMO_PORTAL_ID), false);
  assert.equal(mayOpenPortal(client, ""), false);
});

test("clients are guarded and counted as clients", () => {
  assert.equal(guardRole({ kind: "client", email: "a@b.c", portals: [DEMO_PORTAL_ID] }), "client");
  assert.equal(guardRole({ kind: "staff", email: "a@b.c" }), "staff");
});
