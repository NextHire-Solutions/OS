/*
 * Admin-rights tests.
 *
 * Two behaviours matter and both are deliberate rather than accidental, so
 * both are pinned: the bootstrap fail-open (nobody listed => everyone signed
 * in is an admin) and the authoritative mode that replaces it.
 *
 *   node --test src/lib/identity/admin.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { adminEmails, coerceTools, describeAdmins, isAdmin, GRANTABLE_TOOLS } from "./admin.ts";

function withEnv(value: string | undefined, run: () => void) {
  const previous = process.env.ADMIN_EMAILS;
  if (value === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = value;
  try { run(); } finally {
    if (previous === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previous;
  }
}

/** Run with AUTH_USERS set to the given allow-list, restoring it after. */
function withAuthUsers(value: string | undefined, fn: () => void) {
  const prev = process.env.AUTH_USERS;
  if (value === undefined) delete process.env.AUTH_USERS; else process.env.AUTH_USERS = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.AUTH_USERS; else process.env.AUTH_USERS = prev;
  }
}

test("unset ADMIN_EMAILS makes every AUTH_USERS operator an admin — and nobody else", () => {
  // The bootstrap fail-open. Without it the first deploy produces a Team
  // access screen that refuses its only user. It reaches AUTH_USERS only:
  // since 0004 an invited person can sign in too, and the first live invite
  // came back as "Owner, every tool" while this said "everyone signed in".
  withEnv(undefined, () => withAuthUsers("owner@brokerstaffer.com:abc, Second@brokerstaffer.com:def", () => {
    assert.equal(isAdmin("owner@brokerstaffer.com"), true);
    assert.equal(isAdmin("second@brokerstaffer.com"), true, "case-insensitive, like sign-in");
    assert.equal(isAdmin("invited@brokerstaffer.com"), false, "an invited person is never an admin by default");
    assert.equal(describeAdmins().governed, false, "and it reports itself as ungoverned");
  }));
});

test("an empty or whitespace ADMIN_EMAILS counts as unset, not as 'nobody'", () => {
  // "Nobody is an admin" would lock the workspace out of its own settings with
  // no way back short of a redeploy.
  withEnv("  \n , ", () => withAuthUsers("owner@brokerstaffer.com:abc", () => {
    assert.equal(isAdmin("owner@brokerstaffer.com"), true);
    assert.equal(isAdmin("invited@brokerstaffer.com"), false);
    assert.equal(describeAdmins().governed, false);
  }));
});

test("once set, ADMIN_EMAILS is authoritative", () => {
  withEnv("sam@brokerstaffer.com", () => {
    assert.equal(isAdmin("sam@brokerstaffer.com"), true);
    assert.equal(isAdmin("nicole@brokerstaffer.com"), false, "signing in no longer implies admin");
    assert.equal(describeAdmins().governed, true);
  });
});

test("admin matching ignores case and surrounding whitespace", () => {
  withEnv(" SAM@BrokerStaffer.com , nicole@brokerstaffer.com ", () => {
    assert.equal(isAdmin("  sam@BROKERSTAFFER.com  "), true);
    assert.equal(isAdmin("nicole@brokerstaffer.com"), true);
    assert.equal(adminEmails().length, 2);
  });
});

test("a missing email is never an admin, even in bootstrap mode", () => {
  withEnv(undefined, () => {
    assert.equal(isAdmin(null), false);
    assert.equal(isAdmin(undefined), false);
    assert.equal(isAdmin(""), false);
  });
});

test("coerceTools drops anything that is not a real tool", () => {
  // Guards the future PATCH: a typo, or a hand-crafted request, must grant
  // nothing rather than something.
  assert.deepEqual(coerceTools(["inbox", "database", "*", "admin"]), ["inbox"]);
  assert.deepEqual(coerceTools([]), []);
  assert.deepEqual(coerceTools("inbox"), [], "a bare string is not a list");
  assert.deepEqual(coerceTools(null), []);
  assert.deepEqual(coerceTools([1, true, {}]), []);
});

test("coerceTools normalises case and order so results are stable", () => {
  assert.deepEqual(coerceTools([" SEARCH ", "Inbox"]), ["inbox", "search"]);
});

test("the grantable tools exclude the Database app", () => {
  // The status board still monitors it; nobody can be granted it. The two
  // lists answer different questions and are allowed to differ.
  const ids = GRANTABLE_TOOLS.map((t) => t.id);
  assert.deepEqual(ids, ["inbox", "clients", "analytics", "search", "onboarding"]);
  assert.equal(ids.includes("database" as never), false);
});

test("every grantable tool has a label and a description for the screen", () => {
  for (const tool of GRANTABLE_TOOLS) {
    assert.ok(tool.label.length > 0, `${tool.id} needs a label`);
    assert.ok(tool.description.length > 0, `${tool.id} needs a description`);
  }
});
