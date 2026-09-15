import assert from "node:assert/strict";
import { describe, test as it } from "node:test";
import { coerceUserRow, generateTemporaryPassword, indexUserRows, mergeUsers } from "./user-table.ts";

const env = (email: string, grants: string[] = ["inbox"]) => ({
  email, passwordHash: "e".repeat(64), tokenVersion: 1, grants: grants as never, isActive: true,
});

describe("coerceUserRow", () => {
  it("normalises the address and hash, defaults the flags", () => {
    const row = coerceUserRow({ email: " Sam@X.com ", password_hash: "ABC" });
    assert.ok(row);
    assert.equal(row.email, "sam@x.com"); assert.equal(row.passwordHash, "abc");
    assert.equal(row.isActive, true); assert.equal(row.mustChangePassword, true); assert.equal(row.tokenVersion, 1);
  });
  it("rejects a row with no hash — it could never sign in, and must not be listed as if it could", () => {
    assert.equal(coerceUserRow({ email: "sam@x.com" }), null);
    assert.equal(coerceUserRow({ email: "", password_hash: "abc" }), null);
  });
  it("keeps a deactivated row deactivated", () => {
    assert.equal(coerceUserRow({ email: "a@x.com", password_hash: "h", is_active: false })?.isActive, false);
  });
});

describe("generateTemporaryPassword", () => {
  it("is 4 groups of 4 with no look-alike characters", () => {
    for (let i = 0; i < 50; i++) {
      const p = generateTemporaryPassword();
      assert.match(p, /^[a-hj-km-np-z2-9]{4}(-[a-hj-km-np-z2-9]{4}){3}$/);
    }
  });
  it("is deterministic for a given random source", () => {
    const fixed = (n: number) => new Uint8Array(n).fill(7);
    assert.equal(generateTemporaryPassword(fixed), generateTemporaryPassword(fixed));
  });
  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTemporaryPassword()));
    assert.equal(seen.size, 200);
  });
});

describe("mergeUsers", () => {
  it("lists env people and invited people together, sorted", () => {
    const db = indexUserRows([{ email: "zed@x.com", password_hash: "h", name: "Zed" }]);
    const out = mergeUsers([env("amy@x.com")], db, null);
    assert.deepEqual(out.map((u) => [u.email, u.source]), [["amy@x.com", "env"], ["zed@x.com", "db"]]);
  });
  it("an env address stays an env account but takes its password from its table row", () => {
    const db = indexUserRows([{ email: "amy@x.com", password_hash: "dbhash", token_version: 3 }]);
    const out = mergeUsers([env("amy@x.com")], db, null);
    assert.equal(out.length, 1, "one person, not two");
    assert.equal(out[0].source, "env", "identity and admin standing come from AUTH_USERS");
    assert.equal(out[0].passwordHash, "dbhash", "the password they set in the OS");
    assert.equal(out[0].tokenVersion, 3);
  });
  it("an env address with no table row signs in with its env hash", () => {
    const out = mergeUsers([env("amy@x.com")], new Map(), null);
    assert.equal(out[0].passwordHash, "e".repeat(64));
  });
  it("grants come from the table for everyone; an invited person with no row has none", () => {
    const db = indexUserRows([{ email: "zed@x.com", password_hash: "h" }, { email: "kim@x.com", password_hash: "h" }]);
    const grants = new Map([["zed@x.com", ["clients"]], ["amy@x.com", ["search"]]]) as never;
    const out = mergeUsers([env("amy@x.com", ["inbox"])], db, grants);
    const by = Object.fromEntries(out.map((u) => [u.email, u.grants]));
    assert.deepEqual(by["zed@x.com"], ["clients"]);
    assert.deepEqual(by["amy@x.com"], ["search"]);
    assert.deepEqual(by["kim@x.com"], []);
  });
  it("carries deactivation through", () => {
    const db = indexUserRows([{ email: "zed@x.com", password_hash: "h", is_active: false }]);
    assert.equal(mergeUsers([], db, null)[0].isActive, false);
  });
});
