/*
 * Who may open and change which portal in the new design (viewer-rules.ts, 27–29 Oct). Run with
 * node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs --test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { DEMO_PORTAL_ID } from "./demo.ts";
import { BILLING_TAB_PEOPLE } from "../clients/billing-access.ts";
import { BROKERSTAFFER_PORTAL_ID, CLIENT_LAUNCH_ENV, clientPortals, clientsOn, DEMO_CLIENT_TESTERS, guardRole, mayOpenPortal, mayWritePortal, openRule, opensTo, openToClients, type CrmViewer } from "./viewer-rules.ts";

const REAL = "6b787a4c-22e1-4ba7-96e2-f7a4f3eaf849";
const OTHER = "492b2783-280f-4c6d-8807-a3de56c59ab1";
const ME = "admin@outreachify.io";
const CLIENT = "owner@client.test";

/* The launch switch, as the server would read it, for the length of one check. */
function withClients<T>(on: boolean | string | undefined, run: () => T): T {
  const was = process.env[CLIENT_LAUNCH_ENV];
  if (on === undefined) delete process.env[CLIENT_LAUNCH_ENV];
  else process.env[CLIENT_LAUNCH_ENV] = on === true ? "1" : on === false ? "" : on;
  try { return run(); } finally { if (was === undefined) delete process.env[CLIENT_LAUNCH_ENV]; else process.env[CLIENT_LAUNCH_ENV] = was; }
}

test("the launch switch is the sign-in email's own switch (portal-login/mail.ts), and only exactly \"1\" turns it on", () => {
  assert.match(fs.readFileSync("src/lib/portal-login/mail.ts", "utf8"), new RegExp(`export const SIGNIN_ENV = "${CLIENT_LAUNCH_ENV}";`));
  for (const v of [undefined, "", "0", "true", "yes", " 1x", "on"]) assert.equal(clientsOn({ [CLIENT_LAUNCH_ENV]: v }), false, String(v));
  assert.equal(clientsOn({ [CLIENT_LAUNCH_ENV]: "1" }), true);
  assert.equal(clientsOn({ [CLIENT_LAUNCH_ENV]: " 1 " }), true);
});

test("the Demo opens as a client only to the named testers — never by the sign-in list alone, switch on or off", () => {
  assert.deepEqual([...DEMO_CLIENT_TESTERS], ["admin@outreachify.io", "eddy@brokerstaffer.com", "amy@brokerstaffer.com"]);
  for (const t of DEMO_CLIENT_TESTERS) assert.ok(BILLING_TAB_PEOPLE.includes(t), `${t} is a by-name account, protected from takeover by an ordinary admin`);
  for (const on of [true, false, undefined]) withClients(on, () => {
    assert.equal(openRule(DEMO_PORTAL_ID), "testers");
    assert.equal(openToClients(DEMO_PORTAL_ID, ME), true);
    assert.equal(openToClients(DEMO_PORTAL_ID, " Eddy@BrokerStaffer.com "), true, "case and spaces aside");
    assert.equal(openToClients(DEMO_PORTAL_ID, CLIENT), false, "on the list, not named: the holding page");
    assert.equal(openToClients(DEMO_PORTAL_ID, ""), false);
  });
});

test("switch OFF (as before the launch): a real portal opens only to the named testers — no client gets in", () => {
  withClients(undefined, () => {
    for (const id of [REAL, OTHER, BROKERSTAFFER_PORTAL_ID]) {
      assert.equal(openRule(id), "testers", id);
      assert.equal(openToClients(id, CLIENT), false, id);
      assert.equal(openToClients(id, ME), true, `${id}: a tester, when on its list`);
    }
    assert.deepEqual(clientPortals([REAL, DEMO_PORTAL_ID, OTHER], CLIENT), []);
    assert.equal(mayOpenPortal({ kind: "client", email: CLIENT, portals: [REAL] }, REAL), false);
    assert.equal(mayWritePortal({ kind: "client", email: CLIENT, portals: [REAL] }, REAL), false);
  });
});

test("switch ON (the launch): every real portal opens to the addresses on its own list — and only those", () => {
  withClients(true, () => {
    for (const id of [REAL, OTHER, BROKERSTAFFER_PORTAL_ID]) assert.equal(openRule(id), "listed", id);
    assert.equal(openToClients(REAL, CLIENT), true);
    assert.equal(openToClients(REAL, "  "), false, "no address, no way in");
    // clientPortals is given only the portals the address IS on (the session's sign-in lists): it keeps those.
    assert.deepEqual(clientPortals([REAL, OTHER, REAL], CLIENT), [REAL, OTHER]);
    const client: CrmViewer = { kind: "client", email: CLIENT, portals: [REAL] };
    assert.equal(mayOpenPortal(client, REAL), true);
    assert.equal(mayOpenPortal(client, OTHER), false, "another client's portal: never");
    assert.equal(mayWritePortal(client, REAL), true);
    assert.equal(mayWritePortal(client, OTHER), false);
    assert.equal(mayWritePortal(client, DEMO_PORTAL_ID), false, "the Demo stays the testers'");
  });
});

test("STAFF (the reviewers) open and change ANY portal — the Demo and every real one (29 Oct)", () => {
  const staff: CrmViewer = { kind: "staff", email: ME };
  for (const on of [true, false, undefined]) withClients(on, () => {
    for (const id of [REAL, OTHER, DEMO_PORTAL_ID, BROKERSTAFFER_PORTAL_ID]) {
      assert.equal(mayOpenPortal(staff, id), true, id);
      assert.equal(mayWritePortal(staff, id), true, id);
    }
    assert.equal(mayWritePortal(staff, ""), false);
    assert.equal(mayWritePortal(staff, null), false);
  });
});

test("nobody else: no viewer, no portal", () => {
  for (const on of [true, false]) withClients(on, () => {
    assert.equal(mayOpenPortal(null, REAL), false);
    assert.equal(mayWritePortal(null, DEMO_PORTAL_ID), false);
    assert.equal(mayOpenPortal({ kind: "client", email: CLIENT, portals: [] }, REAL), false, "a portal not on their list");
  });
});

test("opensTo: listed lets in any address; testers only the named three; anything else no one", () => {
  assert.equal(opensTo("listed", CLIENT), true);
  assert.equal(opensTo("listed", "  "), false);
  assert.equal(opensTo("testers", CLIENT), false);
  assert.equal(opensTo("testers", ME), true);
  assert.equal(opensTo(undefined, ME), false);
});

test("clients are guarded and counted as clients, staff as staff", () => {
  assert.equal(guardRole({ kind: "client", email: ME, portals: [DEMO_PORTAL_ID] }), "client");
  assert.equal(guardRole({ kind: "staff", email: ME }), "staff");
});
