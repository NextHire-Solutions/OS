/*
 * The gate itself (viewer.ts), with the sign-ins stubbed: staff first, then a
 * client's session narrowed to what is open to them; anything else null.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

const DEMO = "00ef116c-646d-43b4-a323-680548ea7126";
const REAL = "6b787a4c-22e1-4ba7-96e2-f7a4f3eaf849";
const STAFF_TOKENS: Record<string, string> = { reviewer: "eddy@brokerstaffer.com", owner: "admin@outreachify.io", colleague: "ryan.j@brokerstaffer.com" };
const SESSIONS: Record<string, { email: string; portals: string[] } | "throws"> = {
  tester: { email: "admin@outreachify.io", portals: [DEMO, REAL] },
  outsider: { email: "someone@client.test", portals: [DEMO] },
  realonly: { email: "admin@outreachify.io", portals: [REAL] },
  broken: "throws",
};

mock.module("../bs-auth.ts", {
  namedExports: {
    readSsoCookie: (c: string | null) => c,
    verifySso: async (_secret: string, token: string | undefined) => (token && STAFF_TOKENS[token] ? { email: STAFF_TOKENS[token] } : null),
  },
});
mock.module("../identity/admin.ts", { namedExports: { adminEmails: () => ["admin@outreachify.io"] } });
mock.module("../supabase/admin.ts", { namedExports: { createAdminSupabase: () => ({}) } });
mock.module("../portal-login/login.ts", {
  namedExports: {
    readSession: async (_db: unknown, s: string) => {
      const v = SESSIONS[s];
      if (v === "throws") throw new Error("database down");
      return v ?? null;
    },
  },
});
mock.module("../portal-login/http.ts", { namedExports: { PORTAL_COOKIE: "bs_portal" } });

const { crmViewer } = await import("./viewer.ts");

test("staff first: a reviewer's sign-in is staff, whatever client cookie rides along", async () => {
  assert.deepEqual(await crmViewer({ sso: "reviewer", portal: "outsider" }), { kind: "staff", email: "eddy@brokerstaffer.com" });
  assert.deepEqual(await crmViewer({ sso: "owner", portal: undefined }), { kind: "staff", email: "admin@outreachify.io" });
});

test("a colleague who is not a reviewer is not staff here — and falls to their client sign-in, if any", async () => {
  assert.equal(await crmViewer({ sso: "colleague", portal: undefined }), null);
  assert.deepEqual(await crmViewer({ sso: "colleague", portal: "tester" }), { kind: "client", email: "admin@outreachify.io", portals: [DEMO] });
});

test("a client: only portals open to them — the Demo, for a named tester; never a real portal; never an outsider", async () => {
  assert.deepEqual(await crmViewer({ sso: undefined, portal: "tester" }), { kind: "client", email: "admin@outreachify.io", portals: [DEMO] });
  assert.equal(await crmViewer({ sso: undefined, portal: "outsider" }), null, "on the Demo's list but not named: nothing");
  assert.equal(await crmViewer({ sso: undefined, portal: "realonly" }), null, "a real portal only: nothing until the switch");
});

test("no sign-in, an unknown session, or the database failing: null (the caller answers Not found)", async () => {
  assert.equal(await crmViewer({ sso: undefined, portal: undefined }), null);
  assert.equal(await crmViewer({ sso: "forged", portal: "unknown" }), null);
  assert.equal(await crmViewer({ sso: undefined, portal: "broken" }), null);
});
