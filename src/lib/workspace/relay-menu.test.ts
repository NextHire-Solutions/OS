/*
 * Master Inbox › Brokerage hand-off in the menu (18 Nov, Eddy: "Can you make this menu obvious on the OS?") — shown to
 * admins and the people the page is opened to by name (Amy, the user: "add amy to the brokerage hand off page"), to
 * nobody else; its address and the old Settings one both open it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { canSeeLeaf, destinations, idForPath, NAV, pathForId, type NavProduct } from "./nav.ts";
import { namedPagesFor } from "../identity/named-pages.ts";

const inbox = NAV.flatMap((s) => s.items).find((i) => i.kind === "product" && i.id === "inbox") as NavProduct;
const leaf = inbox.children.find((c) => c.id === "brokerage-relay")!;

test("the entry: under Master Inbox, before Settings, for the Brokerage hand-off tab", () => {
  assert.ok(leaf);
  assert.equal(leaf.label, "Brokerage hand-off");
  assert.equal(leaf.page, "brokerage-relay");
  const ids = inbox.children.map((c) => c.id);
  assert.ok(ids.indexOf("brokerage-relay") < ids.indexOf("settings"));
  // Every other inbox entry stays for everyone with the Master Inbox switch.
  for (const c of inbox.children) if (c.id !== "brokerage-relay") assert.equal(c.page, undefined, c.id);
});

test("who sees it: admins, and Amy by name — not teammates, whatever their roles", () => {
  assert.equal(canSeeLeaf(leaf, true), true);
  assert.equal(canSeeLeaf(leaf, false, { pages: namedPagesFor("amy@brokerstaffer.com") }), true);
  for (const roles of [{}, { accountManager: true }, { salesperson: true }, { pages: ["reply-agent"] }, { pages: namedPagesFor("gabriel@brokerstaffer.com") }]) {
    assert.equal(canSeeLeaf(leaf, false, roles), false, JSON.stringify(roles));
  }
  // An entry without a page is for everyone (who holds the product's switch).
  assert.equal(canSeeLeaf({}, false, {}), true);
});

test("its addresses: /inbox/brokerage-relay is its own screen; the Settings tab's address still opens Settings on it", () => {
  assert.equal(pathForId("inbox:brokerage-relay"), "/inbox/brokerage-relay");
  assert.equal(idForPath("/inbox/brokerage-relay"), "inbox:brokerage-relay");
  assert.equal(idForPath("/inbox/settings/brokerage-relay"), "inbox:settings");
  assert.equal(idForPath("/inbox/settings"), "inbox:settings");
});

test("the search palette carries the same rule (it offers exactly what the menu does)", () => {
  const d = destinations().find((x) => x.id === "inbox:brokerage-relay")!;
  assert.equal(d.page, "brokerage-relay");
  assert.equal(d.grant, "inbox");
  assert.equal(destinations().filter((x) => x.page).length, 1, "only this entry is named");
});
