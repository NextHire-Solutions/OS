/*
 * The Brokerage hand-off page's check (18 Nov): admins, and Amy by name — a 403 for anyone else, signed in or not an
 * admin. Run with node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs --test.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const skip = !canMock && "needs --experimental-test-module-mocks";
let who = "";
const ADMINS = new Set(["eddy@brokerstaffer.com", "admin@outreachify.io"]);

let mod: typeof import("./require-relay.ts");
if (canMock) {
  mock.module("@/lib/identity/admin-db", { namedExports: { isAdminUser: async (e: string | null | undefined) => ADMINS.has(String(e ?? "").trim().toLowerCase()) } });
  mock.module("@/lib/auth/workspace", { namedExports: { requireSession: async () => ({ user: { email: who }, activeWorkspace: { id: "w" } }) } });
  mod = await import("./require-relay.ts");
}

test("admins and Amy may use the page; nobody else", { skip }, async () => {
  for (const email of ["eddy@brokerstaffer.com", "admin@outreachify.io", "amy@brokerstaffer.com", " Amy@BrokerStaffer.com "]) assert.equal(await mod.canManageRelay(email), true, email);
  for (const email of ["gabriel@brokerstaffer.com", "ryan.j@brokerstaffer.com", "amy@brokerstaffer.co", "", null, undefined]) assert.equal(await mod.canManageRelay(email), false, String(email));
});

test("the routes' session: Amy's passes, a teammate's is a 403 with the usual words", { skip }, async () => {
  who = "amy@brokerstaffer.com";
  const ok = await mod.requireRelaySession();
  assert.equal((ok as { user: { email: string } }).user.email, "amy@brokerstaffer.com");
  who = "gabriel@brokerstaffer.com";
  const no = (await mod.requireRelaySession()) as Response;
  assert.equal(no.status, 403);
  assert.deepEqual(await no.json(), { error: "Only workspace admins can run this." });
});
