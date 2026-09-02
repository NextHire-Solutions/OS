/*
 * Grant-store tests.
 *
 * The interesting cases are all about failing in the safe direction: an
 * unlisted user gets nothing, a typo'd tool grants nothing, and the one
 * deliberate fail-open (BS_GRANTS entirely unset) is pinned so it cannot be
 * widened by accident later.
 *
 *   node --test src/lib/identity/store.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { EnvGrantStore } from "./store.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const USERS = `sam@brokerstaffer.com:${HASH_A}, nicole@brokerstaffer.com:${HASH_B}`;

test("BS_GRANTS is authoritative when set", async () => {
  const store = new EnvGrantStore(
    USERS,
    `sam@brokerstaffer.com:inbox,analytics
     nicole@brokerstaffer.com:clients`,
  );

  assert.deepEqual((await store.findByEmail("sam@brokerstaffer.com"))?.grants, [
    "inbox",
    "analytics",
  ]);
  assert.deepEqual((await store.findByEmail("nicole@brokerstaffer.com"))?.grants, [
    "clients",
  ]);
  assert.equal(store.describe().governed, true);
});

test("a user in AUTH_USERS but absent from BS_GRANTS gets NOTHING", async () => {
  // The important fail-closed case: existing is not the same as entitled.
  const store = new EnvGrantStore(USERS, "sam@brokerstaffer.com:inbox");
  const nicole = await store.findByEmail("nicole@brokerstaffer.com");

  assert.ok(nicole, "she can still authenticate");
  assert.deepEqual(nicole.grants, [], "but is entitled to no tools");
});

test("with BS_GRANTS entirely unset, listed operators get every tool", async () => {
  // A deliberate fail-open, pinned here so it is a decision rather than a
  // drift. Without it, deploying SSO would lock the existing admin out of
  // their own dashboard with no way back in.
  const store = new EnvGrantStore(USERS, undefined);
  const sam = await store.findByEmail("sam@brokerstaffer.com");

  assert.deepEqual(sam?.grants, ["inbox", "clients", "analytics", "search"]);
  assert.equal(store.describe().governed, false, "and it reports itself as ungoverned");
});

test("an empty BS_GRANTS string is treated as unset, not as 'nobody'", async () => {
  const store = new EnvGrantStore(USERS, "   \n  ");
  assert.equal(store.describe().governed, false);
  assert.equal((await store.findByEmail("sam@brokerstaffer.com"))?.grants.length, 4);
});

test("unknown tool names are dropped, not trusted", async () => {
  const store = new EnvGrantStore(USERS, "sam@brokerstaffer.com:inbox,database,admin,*");
  assert.deepEqual((await store.findByEmail("sam@brokerstaffer.com"))?.grants, ["inbox"]);
});

test("grants named in BS_GRANTS for someone who cannot sign in are inert", async () => {
  const store = new EnvGrantStore(
    `sam@brokerstaffer.com:${HASH_A}`,
    "ghost@brokerstaffer.com:inbox,clients,analytics,search",
  );
  assert.equal(await store.findByEmail("ghost@brokerstaffer.com"), null);
  assert.equal((await store.listUsers()).length, 1);
});

test("email matching is case- and whitespace-insensitive on both sides", async () => {
  const store = new EnvGrantStore(
    `  SAM@BrokerStaffer.com : ${HASH_A} `,
    " Sam@BROKERSTAFFER.com : inbox ",
  );
  const user = await store.findByEmail("  sAm@brokerstaffer.COM ");
  assert.equal(user?.email, "sam@brokerstaffer.com");
  assert.deepEqual(user?.grants, ["inbox"]);
});

test("grant order is normalised, so tokens are stable", async () => {
  const store = new EnvGrantStore(USERS, "sam@brokerstaffer.com:search,analytics,inbox");
  assert.deepEqual((await store.findByEmail("sam@brokerstaffer.com"))?.grants, [
    "inbox",
    "analytics",
    "search",
  ]);
});

test("malformed entries are skipped rather than throwing at boot", async () => {
  // A parse error here would take sign-in down for everyone, which is a far
  // worse outcome than ignoring one bad line.
  const store = new EnvGrantStore(
    `nonsense, ,:${HASH_A}, sam@brokerstaffer.com:${HASH_A}`,
    "garbage\n\nsam@brokerstaffer.com:inbox\nalso-garbage",
  );
  assert.equal((await store.listUsers()).length, 1);
  assert.deepEqual((await store.findByEmail("sam@brokerstaffer.com"))?.grants, ["inbox"]);
});

test("an unset AUTH_USERS yields no users at all", async () => {
  const store = new EnvGrantStore(undefined, "sam@brokerstaffer.com:inbox");
  assert.equal((await store.listUsers()).length, 0);
  assert.equal(await store.findByEmail("sam@brokerstaffer.com"), null);
});
