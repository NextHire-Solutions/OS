/*
 * Deleting one portal — the rules, against the code that runs.
 *
 * The user's decisions (13 Oct), each pinned below: admins only (the route's
 * test), "Portal only, client stays", a confirmation before anything goes, and
 * the standing rule that the demo portal is never removed.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  blockReason,
  confirmationMatches,
  exceptionReason,
  leavesClientWithoutPortal,
  nextLink,
  ownerOf,
  portalIsLive,
  protectedReason,
  type OwnerRow,
  type PortalFacts,
} from "./delete-portal-rule.ts";
import { resolveByIdOrName, type MasterFacts } from "./master-lookup.ts";

const portal = (over: Partial<PortalFacts> = {}): PortalFacts => ({
  id: "p-1", name: "Acme Realty", slug: "acme-realty", portalToken: "acme-realty-a1b2c3d4", portalEnabled: false, ...over,
});

describe("what counts as live", () => {
  test("a link that is not switched off is live — null and true both mean on", () => {
    assert.equal(portalIsLive({ portalToken: "t-12345678", portalEnabled: true }), true);
    assert.equal(portalIsLive({ portalToken: "t-12345678", portalEnabled: null }), true, "the column defaults to on");
    assert.equal(portalIsLive({ portalToken: "t-12345678", portalEnabled: false }), false);
  });
  test("no link means nobody can open it, whatever the switch says", () => {
    assert.equal(portalIsLive({ portalToken: null, portalEnabled: true }), false);
    assert.equal(portalIsLive({ portalToken: "   ", portalEnabled: true }), false);
  });
});

describe("the three refusals", () => {
  test("the demo portal is never deletable — on or off, by slug or by name", () => {
    for (const p of [
      portal({ name: "Demo Portal", slug: "demo-portal", portalEnabled: true }),
      portal({ name: "Demo Portal", slug: "demo-portal", portalEnabled: false }),
      portal({ name: "Demo Portal", slug: "something-else", portalEnabled: false }),   // renamed slug
      portal({ name: "Demo  portal", slug: null, portalEnabled: false }),
      portal({ name: "The Demo", slug: "demo-portal", portalEnabled: false }),          // renamed row
    ]) {
      assert.match(blockReason(p) ?? "", /Demo Portal is protected/, JSON.stringify(p));
    }
  });
  test("the Unknown bucket is never deletable", () => {
    assert.match(blockReason(portal({ name: "Unknown", slug: "unknown", portalToken: null })) ?? "", /not a client portal/);
    assert.match(blockReason(portal({ name: "Unknown", slug: null, portalToken: null })) ?? "", /not a client portal/);
  });
  test("a live portal is refused, and told how to proceed", () => {
    assert.match(blockReason(portal({ portalEnabled: true })) ?? "", /Switch it off first/);
    assert.match(blockReason(portal({ portalEnabled: null })) ?? "", /Switch it off first/);
  });
  test("protection is reported before liveness — switching the demo off must not look like the way in", () => {
    assert.match(blockReason(portal({ name: "Demo Portal", slug: "demo-portal", portalEnabled: true })) ?? "", /protected/);
  });
  test("an ordinary portal that is switched off may be deleted", () => {
    assert.equal(blockReason(portal()), null);
    assert.equal(blockReason(portal({ portalToken: null, portalEnabled: true })), null, "no link = not live");
  });
  test("a client whose name merely contains 'demo' or 'unknown' is not protected", () => {
    assert.equal(protectedReason({ name: "Demopolis Realty", slug: "demopolis-realty" }), null);
    assert.equal(protectedReason({ name: "Unknown Horizons Group", slug: "unknown-horizons-group" }), null);
  });
});

const clients: OwnerRow[] = [
  { id: "c-acme", name: "Acme Realty", aliases: ["Acme Boston"], miClientId: "p-1" },
  { id: "c-beta", name: "Beta Homes", aliases: [], miClientId: "p-9" },
  { id: "c-twin-1", name: "Twin Group", aliases: [], miClientId: null },
  { id: "c-twin-2", name: "TWIN group", aliases: [], miClientId: null },
];

describe("whose portal it is", () => {
  test("the stored link wins, even over a name that says otherwise", () => {
    assert.equal(ownerOf(clients, { id: "p-9", name: "Acme Realty" })?.id, "c-beta");
  });
  test("a second portal is tied to its client by name or alias", () => {
    assert.equal(ownerOf(clients, { id: "p-2", name: "Acme Boston" })?.id, "c-acme");
    assert.equal(ownerOf(clients, { id: "p-2", name: "ACME  REALTY." })?.id, "c-acme", "spelling is normalised");
  });
  test("an ambiguous name is not guessed, and a stranger has no owner", () => {
    assert.equal(ownerOf(clients, { id: "p-3", name: "Twin Group" }), null);
    assert.equal(ownerOf(clients, { id: "p-4", name: "Demo Portal" }), null);
    assert.equal(ownerOf(clients, { id: "p-5", name: "" }), null);
  });
  test("it names the same client the Client Portals page shows for the row", () => {
    // The page resolves a row's client with master-lookup's resolveByIdOrName;
    // a delete that meant a different client than the one on screen would be
    // the worst bug this feature could have.
    const facts = clients.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases, status: "active" }) as unknown as MasterFacts);
    const byMi = new Map(clients.filter((c) => c.miClientId).map((c) => [c.miClientId!, facts.find((f) => f.id === c.id)!]));
    for (const [id, name] of [
      ["p-1", "Acme Realty"], ["p-9", "Acme Realty"], ["p-2", "Acme Boston"], ["p-2", "acme realty"],
      ["p-3", "Twin Group"], ["p-4", "Demo Portal"], ["p-5", ""], ["p-6", "Beta Homes"],
    ] as const) {
      assert.equal(
        ownerOf(clients, { id, name })?.id ?? null,
        resolveByIdOrName(byMi, facts, id, name)?.id ?? null,
        `${id} / "${name}"`,
      );
    }
  });
});

describe("what happens to the client's record", () => {
  const acme = clients[0];
  test("untouched when it did not point at the deleted portal", () => {
    assert.deepEqual(nextLink(acme, "p-2", ["p-1"]), { change: false, to: "p-1" });
    assert.deepEqual(nextLink(null, "p-2", []), { change: false, to: null });
  });
  test("moves to the client's other portal when it did — the same one every time", () => {
    assert.deepEqual(nextLink(acme, "p-1", ["p-7", "p-2"]), { change: true, to: "p-2" });
    assert.deepEqual(nextLink(acme, "p-1", ["p-2", "p-7"]), { change: true, to: "p-2" });
  });
  test("is cleared when that was the only portal — never left pointing at a deleted row", () => {
    assert.deepEqual(nextLink(acme, "p-1", []), { change: true, to: null });
  });
  test("a client is 'left without a portal' only when it has an owner and no other portal", () => {
    assert.equal(leavesClientWithoutPortal(acme, []), true);
    assert.equal(leavesClientWithoutPortal(acme, ["p-2"]), false);
    assert.equal(leavesClientWithoutPortal(null, []), false, "an unowned portal leaves no client behind");
  });
});

describe("the note for Consistency", () => {
  test("says what was deleted, when, by whom, and that the client was kept", () => {
    const text = exceptionReason("Acme Boston", new Date("2026-10-13T23:30:00Z"), "owner@example.com");
    assert.equal(text, 'Its portal "Acme Boston" was deleted on Oct 13, 2026 by owner@example.com (Client Portals → Delete). The client was kept.');
  });
  test("is never blank — the table refuses a blank reason", () => {
    assert.ok(exceptionReason("", new Date("2026-10-13T00:00:00Z"), null).trim().length > 20);
  });
});

describe("the typed confirmation", () => {
  test("the exact name, forgiving only outer spaces", () => {
    assert.equal(confirmationMatches("Acme Realty", "Acme Realty"), true);
    assert.equal(confirmationMatches("  Acme Realty ", "Acme Realty"), true);
    assert.equal(confirmationMatches("acme realty", "Acme Realty"), false);
    assert.equal(confirmationMatches("Acme", "Acme Realty"), false);
    assert.equal(confirmationMatches("", "Acme Realty"), false);
  });
  test("a nameless row cannot be confirmed by typing nothing", () => {
    assert.equal(confirmationMatches("", ""), false);
    assert.equal(confirmationMatches("  ", " "), false);
  });
});
