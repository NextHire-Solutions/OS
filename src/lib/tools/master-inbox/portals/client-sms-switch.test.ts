/*
 * The staff "SMS" switch on the Client Portals page: PATCH
 * /api/tools/master-inbox/clients/[id] with { sms_alerts } turns the
 * team_sms_notifications flag on or off for one client and leaves every other
 * flag — and every portal column — alone.
 *
 * Ported from the standalone Master Inbox (lib/portals/client-sms-switch.test.ts,
 * c4b6b77): the first seven tests are the standalone's. The rest are the OS's
 * own, because this route carries two things the standalone's does not — the
 * portal guard that freezes a client's portal URL, and flags written by the
 * OS's onboarding (withStandardFlags), which must never drop this one.
 *
 * The route runs for real against the in-memory PostgREST (see
 * test/fake-postgrest.ts). Only the staff-session check is mocked, because it
 * reads auth cookies that don't exist in a test.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";

import { configureFakeEnvironment, FakePostgrest } from "../test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
process.env.CLIENT_PORTALS_ENABLED = "true"; // read at import by portals/flag.ts

const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

let signedIn = true;
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

type Patch = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
let PATCH: Patch | null = null;
if (canMock) {
  mock.module("../../../../app/api/tools/master-inbox/clients/route", {
    namedExports: {
      requireAuthedUser: async () =>
        signedIn
          ? { user: { id: null, email: "staff@example.com" } }
          : { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) },
      retagUnknownThreads: async () => {},
    },
  });
  ({ PATCH } = (await import("../../../../app/api/tools/master-inbox/clients/[id]/route")) as { PATCH: Patch });
}
const { withFeatureFlag } = await import("./feature-flags.ts");
const { withStandardFlags } = await import("@/lib/clients/portal-features");
const { TEAM_SMS_FLAG } = await import("./team-sms.ts");

const DEMO = "00ef116c-646d-43b4-a323-680548ea7126";
const OTHER = "11111111-1111-4111-8111-111111111111";
const UNKNOWN = "22222222-2222-4222-8222-222222222222";

function seed() {
  db.reset();
  signedIn = true;
  db.seed("clients", [
    { id: DEMO, name: "Demo Portal", slug: "demo-portal", aliases: [], portal_token: "demo-portal-abc123def4", portal_enabled: true, feature_flags: { manage_stages: true, team_sms_notifications: true } },
    { id: OTHER, name: "Other Client", slug: "other-client", aliases: [], portal_token: "other-client-abc123def4", portal_enabled: true, feature_flags: { manage_stages: true, portal_tour: true } },
    { id: UNKNOWN, name: "Unknown", slug: "unknown", aliases: [], portal_token: null, portal_enabled: true, feature_flags: {} },
  ]);
}

async function patch(id: string, body: unknown) {
  const res = await PATCH!(
    new Request(`http://os.test/api/tools/master-inbox/clients/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return res.status;
}
const row = (id: string) => db.rows("clients").find((r) => r.id === id)!;
const flagsOf = (id: string) => row(id)?.feature_flags;

test("turning SMS on sets the flag and keeps every other flag", { skip }, async () => {
  seed();
  assert.equal(await patch(OTHER, { sms_alerts: true }), 200);
  assert.deepEqual(flagsOf(OTHER), { manage_stages: true, portal_tour: true, team_sms_notifications: true });
});

test("turning SMS off removes only that flag", { skip }, async () => {
  seed();
  assert.equal(await patch(DEMO, { sms_alerts: false }), 200);
  assert.deepEqual(flagsOf(DEMO), { manage_stages: true });
});

test("other clients are untouched", { skip }, async () => {
  seed();
  await patch(OTHER, { sms_alerts: true });
  assert.deepEqual(flagsOf(DEMO), { manage_stages: true, team_sms_notifications: true });
  assert.deepEqual(flagsOf(UNKNOWN), {});
});

test("the 'Unknown' fallback client can't have SMS", { skip }, async () => {
  seed();
  assert.equal(await patch(UNKNOWN, { sms_alerts: true }), 400);
  assert.deepEqual(flagsOf(UNKNOWN), {});
});

test("staff must be signed in", { skip }, async () => {
  seed();
  signedIn = false;
  assert.equal(await patch(OTHER, { sms_alerts: true }), 401);
  assert.deepEqual(flagsOf(OTHER), { manage_stages: true, portal_tour: true });
});

test("the switch must be a boolean", { skip }, async () => {
  seed();
  assert.equal(await patch(OTHER, { sms_alerts: "yes" }), 400);
});

test("withFeatureFlag copies, sets or removes one key, and tolerates a malformed map", () => {
  const flags = { a: true, b: true };
  assert.deepEqual(withFeatureFlag(flags, "c", true), { a: true, b: true, c: true });
  assert.deepEqual(withFeatureFlag(flags, "a", false), { b: true });
  assert.deepEqual(flags, { a: true, b: true }, "never mutates the input");
  assert.deepEqual(withFeatureFlag(null, "c", true), { c: true });
  assert.deepEqual(withFeatureFlag(["x"], "c", true), { c: true });
  assert.deepEqual(withFeatureFlag(undefined, "c", false), {});
});

/* ---- the OS's own ---- */

test("the switch writes feature_flags and nothing else: the portal's URL, on/off and slug are not in the write", { skip }, async () => {
  seed();
  assert.equal(await patch(OTHER, { sms_alerts: true }), 200);
  const writes = db.writes("clients", "PATCH");
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0].body as Record<string, unknown>), ["feature_flags"]);
  assert.equal(writes[0].query.get("id"), `eq.${OTHER}`, "one row, by id");
  assert.equal(row(OTHER).portal_token, "other-client-abc123def4");
  assert.equal(row(OTHER).portal_enabled, true);
  assert.equal(row(OTHER).slug, "other-client");
});

test("before Master Inbox 0079, a request that also changes the portal URL is refused whole — the flag is not written either", { skip }, async () => {
  seed();
  db.missingTables.add("portal_token_aliases");
  const res = await PATCH!(
    new Request(`http://os.test/api/tools/master-inbox/clients/${OTHER}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sms_alerts: true, portal_token: "brand-new-token-123" }) }),
    { params: Promise.resolve({ id: OTHER }) },
  );
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /migration 0079/);
  assert.equal(db.writes("clients", "PATCH").length, 0);
  assert.deepEqual(flagsOf(OTHER), { manage_stages: true, portal_tour: true });
  assert.equal(row(OTHER).portal_token, "other-client-abc123def4");
});

/* ---- changing a portal's URL (16 Oct): the old link keeps working ---- */

const aliases = () => db.rows("portal_token_aliases").map((a) => `${a.old_token}->${a.client_id === OTHER ? "OTHER" : a.client_id === DEMO ? "DEMO" : a.client_id}`).sort();

test("a new URL: the old one is kept, BEFORE the token changes, and the new one is live", { skip }, async () => {
  seed();
  db.seed("portal_token_aliases", []);
  assert.equal(await patch(OTHER, { portal_token: "other-client-new-77aa1" }), 200);
  assert.equal(row(OTHER).portal_token, "other-client-new-77aa1");
  assert.deepEqual(aliases(), ["other-client-abc123def4->OTHER"]);
  const order = db.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.table}`);
  assert.ok(order.indexOf("POST portal_token_aliases") < order.indexOf("PATCH clients"), `old link kept first: ${order.join(", ")}`);
});

test("dropping the old link is only on purpose (keep_old_link: false), and only after the new URL is in", { skip }, async () => {
  seed();
  db.seed("portal_token_aliases", []);
  assert.equal(await patch(OTHER, { portal_token: "other-client-new-77aa1", keep_old_link: false }), 200);
  assert.equal(row(OTHER).portal_token, "other-client-new-77aa1");
  assert.deepEqual(aliases(), [], "the old link no longer opens anything");
});

test("another portal's OLD link can't be taken — it would take over that portal's old links", { skip }, async () => {
  seed();
  db.seed("portal_token_aliases", [{ old_token: "demo-portal-old-1234", client_id: DEMO }]);
  assert.equal(await patch(OTHER, { portal_token: "demo-portal-old-1234" }), 409);
  assert.equal(row(OTHER).portal_token, "other-client-abc123def4");
  assert.equal(db.writes("clients", "PATCH").length, 0);
  assert.deepEqual(aliases(), ["demo-portal-old-1234->DEMO"]);
});

test("going back to its own old link is allowed", { skip }, async () => {
  seed();
  db.seed("portal_token_aliases", [{ old_token: "other-client-old-1234", client_id: OTHER }]);
  assert.equal(await patch(OTHER, { portal_token: "other-client-old-1234" }), 200);
  assert.equal(row(OTHER).portal_token, "other-client-old-1234");
  assert.ok(aliases().includes("other-client-abc123def4->OTHER"), "the link it had until now is kept too");
});

test("the same URL as now writes nothing; a bad URL is refused before anything is written", { skip }, async () => {
  seed();
  db.seed("portal_token_aliases", []);
  assert.equal(await patch(OTHER, { portal_token: "other-client-abc123def4" }), 200);
  assert.equal(db.writes("clients", "PATCH").length, 0);
  assert.deepEqual(aliases(), []);
  for (const bad of ["short", "has spaces in it", "slash/es-in-it", "x".repeat(121)]) {
    assert.equal(await patch(OTHER, { portal_token: bad }), 400, bad);
  }
  assert.equal(db.writes("clients", "PATCH").length + db.writes("portal_token_aliases", "POST").length, 0);
});

test("the Unknown fallback has no portal URL to change", { skip }, async () => {
  seed();
  db.seed("portal_token_aliases", []);
  assert.equal(await patch(UNKNOWN, { portal_token: "unknown-new-token-1" }), 400);
  assert.deepEqual(aliases(), []);
});

test("turning SMS on twice, or off twice, is harmless", { skip }, async () => {
  seed();
  assert.equal(await patch(DEMO, { sms_alerts: true }), 200);
  assert.deepEqual(flagsOf(DEMO), { manage_stages: true, team_sms_notifications: true });
  assert.equal(await patch(OTHER, { sms_alerts: false }), 200);
  assert.deepEqual(flagsOf(OTHER), { manage_stages: true, portal_tour: true });
});

test("a client that does not exist is a 404 and writes nothing", { skip }, async () => {
  seed();
  assert.equal(await patch("33333333-3333-4333-8333-333333333333", { sms_alerts: true }), 404);
  assert.equal(db.writes("clients", "PATCH").length, 0);
});

test("the OS's onboarding flag merge never drops a client's SMS switch, and never turns one on", () => {
  // Three OS code paths re-write feature_flags through withStandardFlags
  // (add-portal, onboard-run, the onboarding portal connector). It only ADDS
  // absent standard flags, so SMS on stays on, and SMS off stays off.
  const on = withStandardFlags({ [TEAM_SMS_FLAG]: true, manage_stages: false });
  assert.equal(on[TEAM_SMS_FLAG], true);
  assert.equal(on.manage_stages, false, "a flag someone turned off stays off");
  const off = withStandardFlags({ manage_stages: true });
  assert.equal(TEAM_SMS_FLAG in off, false, "SMS is opt-in: never part of the standard set");
  assert.equal(TEAM_SMS_FLAG in withStandardFlags(null), false);
});
