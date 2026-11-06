import assert from "node:assert/strict";
import { test } from "node:test";

import { clientMatchEmails, type EmailSourceRow } from "./billing-emails.ts";

/*
 * The addresses the email match may use (6 Nov): each client's people on its record, and on its portals' sign-in lists,
 * with a portal given to a client only by the OS's own rule (delete-portal-rule.ts ownerOf).
 */

const row = (id: string, name: string, o: Partial<EmailSourceRow> = {}): EmailSourceRow => ({ id, name, aliases: [], miClientId: null, ...o });

test("every address on the record: three contacts, the extra contacts and the point of contact, lower-case, once each", () => {
  const out = clientMatchEmails([
    row("acme", "Acme Realty", {
      contactEmail: " Jane@Acme.com ", contact2Email: "bob@acme.com", contact3Email: null, pocEmail: "Office@Acme.com",
      moreContacts: [{ name: "Pat", email: "pat@acme.com" }, { name: "No Email" }, "junk"],
    }),
  ], [], []);
  assert.deepEqual(out.get("acme"), ["jane@acme.com", "bob@acme.com", "office@acme.com", "pat@acme.com"]);
  const again = clientMatchEmails([row("x", "X", { contactEmail: "a@x.com", pocEmail: "A@X.com" })], [], []);
  assert.deepEqual(again.get("x"), ["a@x.com"], "the same address twice is one");
});

test("sign-ins on the client's own portal and on a second portal named by its alias are the client's", () => {
  const out = clientMatchEmails(
    [row("acme", "Acme Realty", { aliases: ["Acme Realty Austin"], miClientId: "p_main" }), row("beta", "Beta Homes")],
    [{ id: "p_main", name: "Acme Realty" }, { id: "p_austin", name: "Acme Realty Austin" }, { id: "p_beta", name: "Beta Homes" }],
    [{ portalId: "p_main", email: "Owner@Acme.com" }, { portalId: "p_austin", email: "austin@acme.com" }, { portalId: "p_beta", email: "b@beta.com" }],
  );
  assert.deepEqual(out.get("acme"), ["owner@acme.com", "austin@acme.com"]);
  assert.deepEqual(out.get("beta"), ["b@beta.com"]);
});

test("a portal no client can be sure of gives its sign-ins to nobody", () => {
  const out = clientMatchEmails(
    [row("a", "Team A", { aliases: ["Shared Name"] }), row("b", "Team B", { aliases: ["Shared Name"] })],
    [{ id: "p_shared", name: "Shared Name" }, { id: "p_orphan", name: "Nobody's Portal" }],
    [{ portalId: "p_shared", email: "x@x.com" }, { portalId: "p_orphan", email: "y@y.com" }, { portalId: "p_gone", email: "z@z.com" }],
  );
  assert.deepEqual(out.get("a"), []);
  assert.deepEqual(out.get("b"), []);
});

test("the record's own portal wins over a name another client shares", () => {
  const out = clientMatchEmails(
    [row("a", "Team A", { miClientId: "p1" }), row("b", "Team A Old", { aliases: ["Team A"] })],
    [{ id: "p1", name: "Team A" }],
    [{ portalId: "p1", email: "owner@teama.com" }],
  );
  assert.deepEqual(out.get("a"), ["owner@teama.com"]);
  assert.deepEqual(out.get("b"), []);
});

test("a portal the rule can't place is some business all the same: its sign-ins match no one, even a client that has them", () => {
  const out = clientMatchEmails(
    [row("acme", "Acme Realty", { contactEmail: "pat@pat-co.com", miClientId: "p-acme" }), row("beta", "Beta Homes", { miClientId: "p-beta" })],
    [{ id: "p-acme", name: "Acme Realty" }, { id: "p-beta", name: "Beta Homes" }, { id: "p-dallas", name: "Beta Homes Dallas" }],
    [{ portalId: "p-dallas", email: "Pat@Pat-Co.com" }, { portalId: "p-acme", email: "owner@acme.com" }],
  );
  assert.deepEqual(out.get("acme"), ["owner@acme.com"], "pat@ is on Acme and on a portal nobody can place: off Acme");
});
