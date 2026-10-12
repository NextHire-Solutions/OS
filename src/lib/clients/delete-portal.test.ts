/*
 * Deleting one client portal — the routes and the library, run for real
 * against the in-memory PostgREST (tools/master-inbox/test/fake-postgrest.ts).
 *
 * What this pins, in the user's words (13 Oct):
 *
 *   "admin only"                      a non-admin is refused, and nothing moves
 *   "Portal only, client stays"       no write ever deletes or renames a client
 *   "ask for the confirmation too"    nothing is deleted without the typed name
 *   the demo portal is never removed  refused switched on AND switched off
 *
 * Only the staff-session check is mocked (it reads cookies). Who is an admin
 * is decided by the real code, from the fake os_users table.
 *
 * The fake has no foreign keys, so the CASCADE itself is not exercised here —
 * that is the database's (migrations 0016/0022/0025). What is asserted is the
 * one statement that triggers it, and every write around it.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";

import { configureFakeEnvironment, FakePostgrest } from "../tools/master-inbox/test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
process.env.CLIENT_PORTALS_ENABLED = "true";
delete process.env.ADMIN_EMAILS; // admins come from the table in this file

const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

let who: string | null = "admin@example.com";
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

type Ctx = { params: Promise<{ id: string }> };
let DELETE: ((request: Request, context: Ctx) => Promise<Response>) | null = null;
let PLAN: ((request: Request, context: Ctx) => Promise<Response>) | null = null;
if (canMock) {
  mock.module("../../app/api/tools/master-inbox/clients/route", {
    namedExports: {
      requireAuthedUser: async () =>
        who
          ? { user: { id: null, email: who } }
          : { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) },
      retagUnknownThreads: async () => {},
    },
  });
  ({ DELETE } = (await import("../../app/api/tools/master-inbox/clients/[id]/route")) as unknown as { DELETE: typeof DELETE });
  ({ GET: PLAN } = (await import("../../app/api/tools/master-inbox/clients/[id]/delete-plan/route")) as unknown as { GET: typeof PLAN });
}
const { adminsChanged } = await import("@/lib/identity/admin-db");
const { planPortalDelete, deletePortal, PortalDeleteRefused } = await import("./delete-portal.ts");

// Portals (Master Inbox `clients` rows).
const BOSTON = "10000000-0000-4000-8000-000000000001"; // Acme's first portal, linked, OFF, full
const FLORIDA = "10000000-0000-4000-8000-000000000002"; // Acme's second portal, by alias, OFF
const LIVE = "10000000-0000-4000-8000-000000000003"; // Beta's portal, LIVE
const SOLO = "10000000-0000-4000-8000-000000000004"; // Solo's only portal, OFF, empty
const DEMO = "00ef116c-646d-43b4-a323-680548ea7126";
const UNKNOWN = "10000000-0000-4000-8000-000000000006";
const STRAY = "10000000-0000-4000-8000-000000000007"; // a test row no client owns, OFF
// Clients (the OS master record).
const ACME = "20000000-0000-4000-8000-000000000001";
const BETA = "20000000-0000-4000-8000-000000000002";
const SOLO_CLIENT = "20000000-0000-4000-8000-000000000003";

function seed() {
  db.reset();
  who = "admin@example.com";
  adminsChanged();
  db.seed("os_users", [
    { email: "admin@example.com", is_admin: true, is_active: true },
    { email: "staff@example.com", is_admin: false, is_active: true },
    { email: "left@example.com", is_admin: true, is_active: false },
  ]);
  db.seed("clients", [
    { id: BOSTON, name: "Acme Boston", slug: "acme-boston", portal_token: "acme-boston-a1b2c3d4", portal_enabled: false },
    { id: FLORIDA, name: "Acme Florida", slug: "acme-florida", portal_token: "acme-florida-e5f6a7b8", portal_enabled: false },
    { id: LIVE, name: "Beta Homes", slug: "beta-homes", portal_token: "beta-homes-c9d0e1f2", portal_enabled: true },
    { id: SOLO, name: "Solo Realty", slug: "solo-realty", portal_token: "solo-realty-0a1b2c3d", portal_enabled: false },
    { id: DEMO, name: "Demo Portal", slug: "demo-portal", portal_token: "demo-portal-abc123def4", portal_enabled: true },
    { id: UNKNOWN, name: "Unknown", slug: "unknown", portal_token: null, portal_enabled: true },
    { id: STRAY, name: "zz QA row", slug: "zz-qa-row", portal_token: "zz-qa-row-99887766", portal_enabled: false },
  ]);
  db.seed("os_clients", [
    { id: ACME, name: "Acme", aliases: ["Acme Boston", "Acme Florida"], status: "active", mi_client_id: BOSTON },
    { id: BETA, name: "Beta Homes", aliases: [], status: "active", mi_client_id: LIVE },
    { id: SOLO_CLIENT, name: "Solo Realty", aliases: [], status: "paused", mi_client_id: SOLO },
  ]);
  db.seed("client_pipeline_entries", [{ client_id: BOSTON }, { client_id: BOSTON }, { client_id: LIVE }]);
  db.seed("client_agents", [{ client_id: BOSTON }, { client_id: BOSTON }, { client_id: BOSTON }, { client_id: FLORIDA }]);
  db.seed("client_dnc_entries", [{ client_id: BOSTON }]);
  db.seed("client_team_members", [{ client_id: BOSTON }, { client_id: DEMO }]);
  db.seed("threads", [{ client_id: BOSTON }, { client_id: BOSTON }, { client_id: SOLO }]);
  db.seed("lists", [{ client_id: BOSTON, name: "Acme Boston" }]);
  db.seed("os_campaign_portals", [
    { campaign_id: "c-1", mi_client_id: BOSTON },
    { campaign_id: "c-2", mi_client_id: BOSTON },
    { campaign_id: "c-3", mi_client_id: FLORIDA },
  ]);
  db.seed("reply_templates", [
    { name: "Intro Macro - Acme Boston" },
    { name: "Intro Macro - Acme Florida" },
    { name: "Intro Macro - Acme Boston (old)" },
  ]);
  db.seed("os_client_tool_exceptions", []);
  db.calls.length = 0;
}

const req = (id: string, body?: unknown) =>
  new Request(`http://os.test/api/tools/master-inbox/clients/${id}`, {
    method: "DELETE",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
async function del(id: string, body?: unknown) {
  const res = await DELETE!(req(id, body), { params: Promise.resolve({ id }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
async function plan(id: string) {
  const res = await PLAN!(new Request(`http://os.test/x`), { params: Promise.resolve({ id }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const portalIds = () => db.rows("clients").map((r) => r.id);
const client = (id: string) => db.rows("os_clients").find((r) => r.id === id)!;
/** Every write the code made, as "METHOD table". */
const writes = () => db.calls.filter((c) => !["GET", "HEAD"].includes(c.method)).map((c) => `${c.method} ${c.table}`);
const untouched = () => {
  assert.deepEqual(writes(), [], "nothing may be written");
  assert.equal(portalIds().length, 7);
};

// ───────────────────────────────────────────────────────────── who may ───

test("signed out: refused, nothing read or written", { skip }, async () => {
  seed();
  who = null;
  assert.equal((await del(BOSTON, { confirm: "Acme Boston", acceptDataLoss: true })).status, 401);
  assert.equal((await plan(BOSTON)).status, 401);
  untouched();
});

test("a team member who is not an admin cannot delete a portal, or preview one", { skip }, async () => {
  seed();
  who = "staff@example.com";
  const r = await del(BOSTON, { confirm: "Acme Boston", acceptDataLoss: true });
  assert.equal(r.status, 403);
  assert.match(String(r.json.error), /Only workspace admins/);
  assert.equal((await plan(BOSTON)).status, 403);
  untouched();
});

test("an admin who has been deactivated is no longer an admin", { skip }, async () => {
  seed();
  who = "left@example.com";
  assert.equal((await del(BOSTON, { confirm: "Acme Boston", acceptDataLoss: true })).status, 403);
  untouched();
});

// ──────────────────────────────────────────────────────── the refusals ───

test("the Demo Portal is refused while live", { skip }, async () => {
  seed();
  const r = await del(DEMO, { confirm: "Demo Portal", acceptDataLoss: true });
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /Demo Portal is protected/);
  untouched();
});

test("the Demo Portal is refused even after someone switches it off", { skip }, async () => {
  seed();
  db.rows("clients").find((r) => r.id === DEMO)!.portal_enabled = false;
  const r = await del(DEMO, { confirm: "Demo Portal", acceptDataLoss: true });
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /protected/);
  untouched();
  const p = await plan(DEMO);
  assert.match(String(p.json.blocked), /protected/);
});

test("the Unknown bucket is refused", { skip }, async () => {
  seed();
  const r = await del(UNKNOWN, { confirm: "Unknown", acceptDataLoss: true });
  assert.equal(r.status, 409);
  untouched();
});

test("a live portal is refused until it is switched off", { skip }, async () => {
  seed();
  const r = await del(LIVE, { confirm: "Beta Homes", acceptDataLoss: true });
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /Switch it off first/);
  untouched();
});

test("a portal switched back on after the preview is still refused — the delete re-reads", { skip }, async () => {
  seed();
  const p = await plan(SOLO);
  assert.equal(p.json.blocked, null);
  db.rows("clients").find((r) => r.id === SOLO)!.portal_enabled = true; // somebody flips Live meanwhile
  db.calls.length = 0;
  assert.equal((await del(SOLO, { confirm: "Solo Realty" })).status, 409);
  untouched();
});

test("a portal that does not exist: 404", { skip }, async () => {
  seed();
  const gone = "99999999-0000-4000-8000-000000000000";
  assert.equal((await del(gone, { confirm: "x" })).status, 404);
  assert.equal((await plan(gone)).status, 404);
  untouched();
});

// ──────────────────────────────────────────────────── the confirmation ───

test("no body, an empty name, a wrong name, or the wrong case: nothing is deleted", { skip }, async () => {
  for (const body of [undefined, {}, { confirm: "" }, { confirm: "Acme" }, { confirm: "acme boston" }, { confirm: "Acme Florida" }, { acceptDataLoss: true }]) {
    seed();
    const r = await del(BOSTON, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(String(r.json.error), /repeat the portal's name exactly/);
    untouched();
  }
});

test("a portal that holds anything also needs the acknowledgement — and only `true` counts", { skip }, async () => {
  for (const acceptDataLoss of [undefined, false, "true", 1, "yes"]) {
    seed();
    const r = await del(BOSTON, { confirm: "Acme Boston", acceptDataLoss });
    assert.equal(r.status, 400, String(acceptDataLoss));
    assert.match(String(r.json.error), /not empty/);
    untouched();
  }
});

test("an empty portal needs the name only", { skip }, async () => {
  seed();
  const r = await del(SOLO, { confirm: "Solo Realty" });
  assert.equal(r.status, 200);
  assert.equal(portalIds().includes(SOLO), false);
});

// ───────────────────────────────────────────────────────── the preview ───

test("the preview counts what is inside, names what stays, and changes nothing", { skip }, async () => {
  seed();
  const p = await planPortalDelete(BOSTON);
  assert.ok(p);
  assert.equal(p.blocked, null);
  assert.deepEqual(
    { leads: p.cascade.pipelineEntries, agents: p.cascade.agents, dnc: p.cascade.dncEntries, team: p.cascade.teamMembers, threads: p.cascade.threads },
    { leads: 2, agents: 3, dnc: 1, team: 1, threads: 2 },
  );
  assert.equal(p.lists, 1);
  assert.equal(p.campaignChoices, 2);
  assert.equal(p.hasTemplate, true);
  assert.equal(p.hasContent, true);
  assert.deepEqual(p.owner, { id: ACME, name: "Acme", status: "active" });
  assert.deepEqual(p.otherPortals, [{ id: FLORIDA, name: "Acme Florida" }]);
  assert.equal(p.leavesClientWithoutPortal, false);
  const removes = p.willDelete.join(" | ");
  for (const needle of ["2 leads", "3 agents", "1 do-not-contact entry", "1 team member", "2 campaigns", "Intro Macro - Acme Boston"]) {
    assert.ok(removes.includes(needle), `${needle} in: ${removes}`);
  }
  const keeps = p.willKeep.join(" | ");
  assert.ok(keeps.includes('the client "Acme"'), keeps);
  assert.ok(keeps.includes('"Acme Florida"'), keeps);
  assert.ok(keeps.includes("2 conversations"), keeps);
  // The leads are the client's introductions on record; other tools count from them.
  assert.ok(p.warnings.some((w) => w.includes("2 leads") && w.includes("introduction counts") && w.includes("Client Health")), p.warnings.join(" | "));
  untouched();
});

test("the preview says when a client is about to be left with no portal", { skip }, async () => {
  seed();
  const p = await planPortalDelete(SOLO);
  assert.ok(p);
  assert.equal(p.leavesClientWithoutPortal, true);
  assert.equal(p.hasContent, false);
  assert.ok(p.warnings.some((w) => w.includes('"Solo Realty" will have no portal')), p.warnings.join(" | "));
  assert.ok(p.warnings.some((w) => w.includes("empty")), "an empty portal is called empty");
  assert.equal(p.warnings.some((w) => w.includes("introduction counts")), false, "no leads, so no numbers to lose");
});

test("a row no client owns previews with no owner", { skip }, async () => {
  seed();
  const p = await planPortalDelete(STRAY);
  assert.ok(p);
  assert.equal(p.owner, null);
  assert.equal(p.leavesClientWithoutPortal, false);
  assert.deepEqual(p.otherPortals, []);
});

// ────────────────────────────────────────────────────────── the delete ───

test("deleting the portal the client record points at moves the record to the client's other portal", { skip }, async () => {
  seed();
  const r = await del(BOSTON, { confirm: "Acme Boston", acceptDataLoss: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.failed, []);
  assert.equal(portalIds().includes(BOSTON), false, "the portal row is gone");
  assert.equal(portalIds().length, 6, "exactly one portal went");

  // The client stays, whole — only its stored link moved.
  assert.deepEqual(client(ACME), { id: ACME, name: "Acme", aliases: ["Acme Boston", "Acme Florida"], status: "active", mi_client_id: FLORIDA });
  assert.equal(db.rows("os_clients").length, 3);
  // Still has a portal, so there is nothing for Consistency to explain.
  assert.equal(db.rows("os_client_tool_exceptions").length, 0);
  // Its template went, by exact name; the neighbours' did not.
  assert.deepEqual(db.rows("reply_templates").map((t) => t.name).sort(), ["Intro Macro - Acme Boston (old)", "Intro Macro - Acme Florida"]);

  assert.deepEqual(writes(), ["DELETE clients", "DELETE reply_templates", "PATCH os_clients"]);
  const [gone] = db.writes("clients", "DELETE");
  assert.equal(gone.query.get("id"), `eq.${BOSTON}`, "one row, by id");
  assert.deepEqual([...gone.query.keys()], ["id"], "no other filter that could widen it");
});

test("deleting a client's second portal leaves the client record exactly as it was", { skip }, async () => {
  seed();
  const before = structuredClone(client(ACME));
  const r = await del(FLORIDA, { confirm: "Acme Florida", acceptDataLoss: true });
  assert.equal(r.status, 200);
  assert.deepEqual(client(ACME), before);
  assert.deepEqual(writes(), ["DELETE clients", "DELETE reply_templates"]);
  assert.equal(db.rows("os_client_tool_exceptions").length, 0);
});

test("deleting a client's only portal keeps the client, clears its link, and tells Consistency why", { skip }, async () => {
  seed();
  const r = await del(SOLO, { confirm: "Solo Realty" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.failed, []);
  assert.deepEqual(client(SOLO_CLIENT), { id: SOLO_CLIENT, name: "Solo Realty", aliases: [], status: "paused", mi_client_id: null });

  const [why] = db.rows("os_client_tool_exceptions");
  assert.equal(why.os_client_id, SOLO_CLIENT);
  assert.equal(why.tool, "master_inbox", "the tool name Consistency reads");
  assert.equal(why.created_by, "admin@example.com");
  assert.match(String(why.reason), /^Its portal "Solo Realty" was deleted on \w{3} \d{1,2}, \d{4} by admin@example\.com \(Client Portals → Delete\)\. The client was kept\.$/);
  assert.deepEqual(writes(), ["DELETE clients", "PATCH os_clients", "POST os_client_tool_exceptions"]);
});

test("a second delete for the same client replaces the note instead of failing on the unique key", { skip }, async () => {
  seed();
  db.seed("os_client_tool_exceptions", [{ os_client_id: SOLO_CLIENT, tool: "master_inbox", reason: "an older note", created_by: "someone@example.com" }]);
  const r = await del(SOLO, { confirm: "Solo Realty" });
  assert.equal(r.status, 200);
  assert.equal(db.rows("os_client_tool_exceptions").length, 1);
  assert.match(String(db.rows("os_client_tool_exceptions")[0].reason), /was deleted on/);
});

test("a row no client owns is deleted and no client record is touched", { skip }, async () => {
  seed();
  const r = await del(STRAY, { confirm: "zz QA row" });
  assert.equal(r.status, 200);
  assert.deepEqual(writes(), ["DELETE clients"]);
});

test("NO delete, by any path, ever deletes or renames a client", { skip }, async () => {
  // "Portal only, client stays" — the one property that must hold whatever
  // else changes in this file.
  for (const [id, name] of [[BOSTON, "Acme Boston"], [FLORIDA, "Acme Florida"], [SOLO, "Solo Realty"], [STRAY, "zz QA row"]] as const) {
    seed();
    const before = db.rows("os_clients").map((c) => ({ id: c.id, name: c.name, aliases: c.aliases, status: c.status }));
    assert.equal((await del(id, { confirm: name, acceptDataLoss: true })).status, 200);
    assert.deepEqual(db.rows("os_clients").map((c) => ({ id: c.id, name: c.name, aliases: c.aliases, status: c.status })), before);
    assert.equal(db.writes("os_clients", "DELETE").length, 0);
    assert.equal(db.writes("os_clients", "POST").length, 0);
    for (const w of db.writes("os_clients", "PATCH")) {
      assert.deepEqual(Object.keys(w.body as object), ["mi_client_id"], "the stored link is the only column ever written");
    }
    // And no other portal is touched: one DELETE on `clients`, one row.
    assert.equal(db.writes("clients", "DELETE").length, 1);
    assert.equal(db.writes("clients", "PATCH").length, 0);
    assert.equal(portalIds().length, 6);
    assert.ok(portalIds().includes(DEMO), "the demo portal is still there");
  }
});

test("the library refuses on its own, without the route in front of it", { skip }, async () => {
  seed();
  await assert.rejects(deletePortal(DEMO, { confirm: "Demo Portal", acceptDataLoss: true }), PortalDeleteRefused);
  await assert.rejects(deletePortal(LIVE, { confirm: "Beta Homes", acceptDataLoss: true }), PortalDeleteRefused);
  await assert.rejects(deletePortal(BOSTON, { confirm: "Acme Boston" }), PortalDeleteRefused);
  untouched();
});
