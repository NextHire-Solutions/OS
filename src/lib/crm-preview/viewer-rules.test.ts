/*
 * Who may open which portal in the new design (viewer-rules.ts, 27 Oct). Run with
 * node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs --test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEMO_PORTAL_ID } from "./demo.ts";
import { BILLING_TAB_PEOPLE } from "../clients/billing-access.ts";
import { BROKERSTAFFER_PORTAL_ID, clientPortals, DEMO_CLIENT_TESTERS, guardRole, mayOpenPortal, mayWritePortal, OPEN_PORTALS, opensTo, openToClients, type CrmViewer } from "./viewer-rules.ts";

const REAL = "6b787a4c-22e1-4ba7-96e2-f7a4f3eaf849";
const OTHER = "492b2783-280f-4c6d-8807-a3de56c59ab1";
const ME = "admin@outreachify.io";
const OUTSIDER = "someone@client.test";

test("the Demo opens as a client only to the named testers — never by the sign-in list alone (security review, 27 Oct)", () => {
  assert.deepEqual([...DEMO_CLIENT_TESTERS], ["admin@outreachify.io", "eddy@brokerstaffer.com", "amy@brokerstaffer.com"]);
  for (const t of DEMO_CLIENT_TESTERS) assert.ok(BILLING_TAB_PEOPLE.includes(t), `${t} is a by-name account, protected from takeover by an ordinary admin`);
  assert.equal(openToClients(DEMO_PORTAL_ID, ME), true);
  assert.equal(openToClients(DEMO_PORTAL_ID, " Eddy@BrokerStaffer.com "), true, "case and spaces aside");
  assert.equal(openToClients(DEMO_PORTAL_ID, OUTSIDER), false, "on the list, not named: the holding page");
  assert.equal(openToClients(DEMO_PORTAL_ID, ""), false);
});

test("until the user says to switch, no real client's portal opens to anyone", () => {
  for (const id of [REAL, OTHER, "", null, undefined]) {
    assert.equal(openToClients(id, ME), false, String(id));
    assert.equal(openToClients(id, OUTSIDER), false, String(id));
  }
  assert.deepEqual(clientPortals([REAL, DEMO_PORTAL_ID, OTHER, DEMO_PORTAL_ID], ME), [DEMO_PORTAL_ID]);
  assert.deepEqual(clientPortals([REAL, DEMO_PORTAL_ID], OUTSIDER), [], "an outsider on the Demo's list: nothing");
  assert.deepEqual(clientPortals([REAL, OTHER], ME), []);
});

test("staff open any portal; a client only their own, open to them", () => {
  const staff: CrmViewer = { kind: "staff", email: ME };
  for (const id of [REAL, OTHER, DEMO_PORTAL_ID]) assert.equal(mayOpenPortal(staff, id), true, id);
  const tester: CrmViewer = { kind: "client", email: ME, portals: [DEMO_PORTAL_ID] };
  assert.equal(mayOpenPortal(tester, DEMO_PORTAL_ID), true);
  assert.equal(mayOpenPortal(tester, REAL), false, "not theirs");
  // A viewer object that somehow lists a portal still cannot open it unless it is open to that address.
  assert.equal(mayOpenPortal({ kind: "client", email: OUTSIDER, portals: [DEMO_PORTAL_ID] }, DEMO_PORTAL_ID), false);
  assert.equal(mayOpenPortal({ kind: "client", email: ME, portals: [REAL] }, REAL), false);
  assert.equal(mayOpenPortal(null, DEMO_PORTAL_ID), false);
  assert.equal(mayOpenPortal(tester, ""), false);
});

test("clients are guarded and counted as clients", () => {
  assert.equal(guardRole({ kind: "client", email: ME, portals: [DEMO_PORTAL_ID] }), "client");
  assert.equal(guardRole({ kind: "staff", email: ME }), "staff");
});

test("open to clients: exactly the Demo and BrokerStaffer's own portal (the pilot), both to the testers only — no real client yet (28 Oct)", () => {
  assert.deepEqual(OPEN_PORTALS, { [DEMO_PORTAL_ID]: "testers", [BROKERSTAFFER_PORTAL_ID]: "testers" });
  assert.equal(openToClients(BROKERSTAFFER_PORTAL_ID, ME), true);
  assert.equal(openToClients(BROKERSTAFFER_PORTAL_ID, "Amy@BrokerStaffer.com"), true);
  assert.equal(openToClients(BROKERSTAFFER_PORTAL_ID, OUTSIDER), false, "on its list but not a tester: not yet");
  assert.deepEqual(clientPortals([BROKERSTAFFER_PORTAL_ID, REAL, OTHER], ME), [BROKERSTAFFER_PORTAL_ID]);
});

test("a switched client (\"listed\") opens to everyone on its list; anything else to no one", () => {
  assert.equal(opensTo("listed", OUTSIDER), true);
  assert.equal(opensTo("listed", "  "), false);
  assert.equal(opensTo("testers", OUTSIDER), false);
  assert.equal(opensTo("testers", ME), true);
  assert.equal(opensTo(undefined, ME), false);
});

test("who may CHANGE a portal: the Demo, its viewers; a real portal, only its own signed-in client — never staff from the preview", () => {
  const staff: CrmViewer = { kind: "staff", email: ME };
  assert.equal(mayWritePortal(staff, DEMO_PORTAL_ID), true, "staff change the Demo, as before");
  for (const id of [BROKERSTAFFER_PORTAL_ID, REAL, OTHER]) assert.equal(mayWritePortal(staff, id), false, `staff never change ${id} from the preview`);
  const pilot: CrmViewer = { kind: "client", email: ME, portals: [BROKERSTAFFER_PORTAL_ID, DEMO_PORTAL_ID] };
  assert.equal(mayWritePortal(pilot, BROKERSTAFFER_PORTAL_ID), true, "a tester signed in on the pilot changes it");
  assert.equal(mayWritePortal(pilot, DEMO_PORTAL_ID), true);
  assert.equal(mayWritePortal(pilot, OTHER), false, "not on their list");
  assert.equal(mayWritePortal({ kind: "client", email: OUTSIDER, portals: [BROKERSTAFFER_PORTAL_ID] }, BROKERSTAFFER_PORTAL_ID), false, "on the list, not a tester");
  assert.equal(mayWritePortal({ kind: "client", email: ME, portals: [OTHER] }, OTHER), false, "a real client not switched: no one changes it");
  assert.equal(mayWritePortal(null, DEMO_PORTAL_ID), false);
  assert.equal(mayWritePortal(pilot, ""), false);
});
