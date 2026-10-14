/*
 * Client Portals comes with the Account manager role (15 Oct) — the rule,
 * and the sign-in store that applies it, against the fake database.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../tools/master-inbox/test/fake-postgrest.ts";
import { grantedByRole, withRoleGrants } from "./role-grants.ts";

/* ------------------------------------------------------------------- rule --- */

test("an account manager gains Client Portals on top of their own tools, in the usual order", () => {
  assert.deepEqual(withRoleGrants(["inbox", "clients", "analytics"], { accountManager: true }), ["inbox", "portals", "clients", "analytics"]);
  assert.deepEqual(withRoleGrants([], { accountManager: true }), ["portals"]);
  assert.deepEqual(withRoleGrants(["portals"], { accountManager: true }), ["portals"], "never twice");
});

test("without the role nothing is added — and nothing else ever is", () => {
  assert.deepEqual(withRoleGrants(["inbox", "analytics"], {}), ["inbox", "analytics"]);
  assert.deepEqual(withRoleGrants(["inbox"], { accountManager: false }), ["inbox"]);
  assert.deepEqual(withRoleGrants(["inbox"], { accountManager: true }).filter((t) => t !== "inbox" && t !== "portals"), []);
});

test("Team access locks only the Client Portals switch, only for an account manager", () => {
  assert.equal(grantedByRole("portals", { accountManager: true }), true);
  assert.equal(grantedByRole("portals", { accountManager: false }), false);
  for (const t of ["inbox", "clients", "analytics", "search", "onboarding"]) assert.equal(grantedByRole(t, { accountManager: true }), false, t);
});

/* ------------------------------------------------------------ the store --- */

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const HASH = "c".repeat(64);
process.env.AUTH_USERS = `owner@brokerstaffer.com:${HASH}`;
process.env.ADMIN_EMAILS = "owner@brokerstaffer.com";
delete process.env.BS_GRANTS;

const { grantStore, __resetGrantStore } = await import("./store.ts");

function seed() {
  db.reset();
  const user = (email: string, extra: Record<string, unknown> = {}) => ({
    email, name: email.split("@")[0], password_hash: HASH, is_active: true, must_change_password: false, token_version: 1, ...extra,
  });
  db.seed("os_users", [
    user("amy@brokerstaffer.com", { is_account_manager: true }),
    user("new-am@brokerstaffer.com", { is_account_manager: true }),
    user("teammate@brokerstaffer.com"),
    user("eddy@brokerstaffer.com", { is_admin: true, is_account_manager: true }),
    user("left@brokerstaffer.com", { is_account_manager: true, is_active: false }),
  ]);
  db.seed("os_tool_grants", [
    { email: "amy@brokerstaffer.com", tools: ["inbox", "clients", "analytics", "onboarding"] },
    { email: "teammate@brokerstaffer.com", tools: ["inbox", "analytics"] },
    { email: "eddy@brokerstaffer.com", tools: ["analytics"] },
  ]);
  __resetGrantStore();
}

test("sign-in and every refresh: an account manager holds Client Portals; a teammate does not", async () => {
  seed();
  const store = grantStore();
  assert.deepEqual((await store.findByEmail("amy@brokerstaffer.com"))?.grants, ["inbox", "portals", "clients", "analytics", "onboarding"]);
  assert.deepEqual((await store.findByEmail("teammate@brokerstaffer.com"))?.grants, ["inbox", "analytics"]);
});

test("an account manager invited with no tools switched on can still sign in — to Client Portals", async () => {
  seed();
  assert.deepEqual((await grantStore().findByEmail("new-am@brokerstaffer.com"))?.grants, ["portals"]);
});

test("admins and owners keep every tool; a deactivated account manager gets nothing", async () => {
  seed();
  const store = grantStore();
  assert.equal((await store.findByEmail("eddy@brokerstaffer.com"))?.grants.length, 6);
  assert.equal((await store.findByEmail("owner@brokerstaffer.com"))?.grants.length, 6);
  assert.equal(await store.findByEmail("left@brokerstaffer.com"), null);
});

test("taking the role away takes Client Portals with it (unless it is switched on for them)", async () => {
  seed();
  db.rows("os_users").find((u) => u.email === "amy@brokerstaffer.com")!.is_account_manager = false;
  assert.equal((await grantStore().findByEmail("amy@brokerstaffer.com"))?.grants.includes("portals"), false);
  db.rows("os_tool_grants").find((g) => g.email === "amy@brokerstaffer.com")!.tools = ["inbox", "portals"];
  assert.deepEqual((await grantStore().findByEmail("amy@brokerstaffer.com"))?.grants, ["inbox", "portals"]);
});

test("nothing was written and nothing left the process", () => {
  assert.equal(db.writes("os_tool_grants", "POST").length + db.writes("os_tool_grants", "PATCH").length + db.writes("os_users", "PATCH").length, 0);
  assert.deepEqual(db.blocked, []);
});
