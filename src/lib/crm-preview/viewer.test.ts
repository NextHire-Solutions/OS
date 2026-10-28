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
  client: { email: "owner@client.test", portals: [REAL] },
  clientdemo: { email: "owner@client.test", portals: [DEMO, REAL] },
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

/* The client launch switch (viewer-rules.ts OS_CLIENT_SIGNIN), for the length of one check. */
async function withClients<T>(on: boolean, run: () => Promise<T>): Promise<T> {
  const was = process.env.OS_CLIENT_SIGNIN;
  if (on) process.env.OS_CLIENT_SIGNIN = "1"; else delete process.env.OS_CLIENT_SIGNIN;
  try { return await run(); } finally { if (was === undefined) delete process.env.OS_CLIENT_SIGNIN; else process.env.OS_CLIENT_SIGNIN = was; }
}

test("a colleague who is not a reviewer is not staff here — and falls to their client sign-in, if any", async () => {
  await withClients(false, async () => {
    assert.equal(await crmViewer({ sso: "colleague", portal: undefined }), null);
    assert.deepEqual(await crmViewer({ sso: "colleague", portal: "tester" }), { kind: "client", email: "admin@outreachify.io", portals: [DEMO, REAL] });
  });
});

test("switch OFF: a client gets nothing; a named tester the portals they are listed on", async () => {
  await withClients(false, async () => {
    assert.deepEqual(await crmViewer({ sso: undefined, portal: "tester" }), { kind: "client", email: "admin@outreachify.io", portals: [DEMO, REAL] });
    assert.deepEqual(await crmViewer({ sso: undefined, portal: "realonly" }), { kind: "client", email: "admin@outreachify.io", portals: [REAL] });
    assert.equal(await crmViewer({ sso: undefined, portal: "outsider" }), null, "on the Demo's list but not named: nothing");
    assert.equal(await crmViewer({ sso: undefined, portal: "client" }), null, "a real client, before the launch: nothing");
    assert.equal(await crmViewer({ sso: undefined, portal: "clientdemo" }), null);
  });
});

test("switch ON (the launch): a client gets the real portals they are listed on — never the Demo", async () => {
  await withClients(true, async () => {
    assert.deepEqual(await crmViewer({ sso: undefined, portal: "client" }), { kind: "client", email: "owner@client.test", portals: [REAL] });
    assert.deepEqual(await crmViewer({ sso: undefined, portal: "clientdemo" }), { kind: "client", email: "owner@client.test", portals: [REAL] }, "the Demo stays the testers'");
    assert.equal(await crmViewer({ sso: undefined, portal: "outsider" }), null, "listed only on the Demo: nothing");
  });
});

test("no sign-in, an unknown session, or the database failing: null (the caller answers Not found)", async () => {
  assert.equal(await crmViewer({ sso: undefined, portal: undefined }), null);
  assert.equal(await crmViewer({ sso: "forged", portal: "unknown" }), null);
  assert.equal(await crmViewer({ sso: undefined, portal: "broken" }), null);
});
