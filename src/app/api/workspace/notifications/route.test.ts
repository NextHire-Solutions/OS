/*
 * The bell's route, run for real with a real signed cookie and the in-memory database. Pinned: admins see everything;
 * Amy, by name, sees the lead cap's alerts and nothing else, and marking read can't touch anything else; anyone else
 * gets no bell at all.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../../../../lib/tools/master-inbox/test/fake-postgrest.ts";
import { mintSso } from "../../../../lib/bs-auth.ts";

configureFakeEnvironment("MASTER_INBOX_");
process.env.AUTH_SECRET = "s".repeat(40);
process.env.ADMIN_EMAILS = "admin@outreachify.io";
delete process.env.SSO_SESSIONS_NOT_BEFORE;

const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});
let watchRuns = 0;
mock.module("../../../../lib/clients/billing-watch", { namedExports: { runBillingWatch: async () => { watchRuns += 1; } } });

const { GET, POST } = await import("./route.ts");

const ADMIN = "admin@outreachify.io";
const AMY = "amy@brokerstaffer.com";

function seed() {
  db.reset();
  watchRuns = 0;
  (globalThis as unknown as { __osBillingWatchAt?: number }).__osBillingWatchAt = 0;
  db.seed("os_users", []);
  db.seed("os_notifications", [
    { id: "n1", kind: "payment_failed", severity: "critical", title: "Payment failed", body: "Secret client", os_client_id: null, read_by: [], created_at: "2026-11-05T10:00:00.000Z", ref: "a" },
    { id: "n2", kind: "lead_cap_reached", severity: "warning", title: "Homebase reached its cap", body: "2 of 2", os_client_id: null, read_by: [], created_at: "2026-11-05T11:00:00.000Z", ref: "b" },
    { id: "n3", kind: "lead_cap_problem", severity: "critical", title: "A campaign didn't pause", body: "x", os_client_id: null, read_by: [], created_at: "2026-11-05T12:00:00.000Z", ref: "c" },
    { id: "n4", kind: "portal_block", severity: "warning", title: "Portal blocked", body: "y", os_client_id: null, read_by: [], created_at: "2026-11-05T13:00:00.000Z", ref: "d" },
    { id: "n5", kind: "lead_cap_restarted", severity: "info", title: "Campaigns restarted", body: "z", os_client_id: null, read_by: [], created_at: "2026-11-05T14:00:00.000Z", ref: "e" },
  ]);
}
const cookie = async (email: string) => `bs_sso=${await mintSso(process.env.AUTH_SECRET!, { email, grants: ["clients", "inbox"], ver: 0 })}`;
const get = async (who: string | null) => GET(new Request("https://os.test/api/workspace/notifications", { headers: who ? { cookie: await cookie(who) } : {} }));
const post = async (who: string | null, body: unknown = {}) => POST(new Request("https://os.test/api/workspace/notifications", { method: "POST", headers: { "content-type": "application/json", ...(who ? { cookie: await cookie(who) } : {}) }, body: JSON.stringify(body) }));

test("nobody signed in: 401, and someone else on the team: 403, so no bell is drawn", async () => {
  seed();
  assert.equal((await get(null)).status, 401);
  for (const who of ["staff@brokerstaffer.com", "someone@outreachify.io", "amy@other.com", "amy.anderes@brokerstaffer.com"]) {
    assert.equal((await get(who)).status, 403, who);
    assert.equal((await post(who)).status, 403, who);
  }
  assert.equal(watchRuns, 0);
});

test("an admin sees everything, as ever", async () => {
  seed();
  const b = await (await get(ADMIN)).json();
  assert.deepEqual(b.items.map((i: { id: string }) => i.id), ["n5", "n4", "n3", "n2", "n1"]);
  assert.equal(b.capsOnly, false);
  assert.equal(b.unread, 5);
});

test("Amy sees the lead cap's alerts and nothing else in the bell", async () => {
  seed();
  const r = await get(AMY);
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.deepEqual(b.items.map((i: { id: string }) => i.id), ["n5", "n3", "n2"]);
  assert.equal(b.capsOnly, true);
  assert.equal(b.unread, 3);
  const raw = JSON.stringify(b);
  assert.doesNotMatch(raw, /Payment failed|Secret client|Portal blocked/);
});

test("Amy, however her address is cased", async () => {
  seed();
  assert.equal((await get("Amy@BrokerStaffer.com")).status, 200);
});

test("Amy's bell doesn't run the billing watch; an admin's does", async () => {
  seed();
  await get(AMY);
  assert.equal(watchRuns, 0);
  await get(ADMIN);
  assert.equal(watchRuns, 1);
});

test("Amy marking all read touches only what she can see, and only for her", async () => {
  seed();
  assert.equal((await post(AMY)).status, 200);
  const byId = new Map(db.rows("os_notifications").map((n) => [n.id, n.read_by]));
  for (const id of ["n2", "n3", "n5"]) assert.deepEqual(byId.get(id), [AMY], id);
  for (const id of ["n1", "n4"]) assert.deepEqual(byId.get(id), [], id);
  assert.equal((await (await get(AMY)).json()).unread, 0);
  assert.equal((await (await get(ADMIN)).json()).unread, 5, "an admin's unread is untouched");
});

test("Amy naming an alert she can't see: nothing happens to it", async () => {
  seed();
  await post(AMY, { ids: ["n1", "n2"] });
  const byId = new Map(db.rows("os_notifications").map((n) => [n.id, n.read_by]));
  assert.deepEqual(byId.get("n1"), []);
  assert.deepEqual(byId.get("n2"), [AMY]);
});

test("the list is limited in the read itself, so her 50 are 50 of hers", async () => {
  seed();
  db.calls.length = 0;
  await get(AMY);
  const read = db.calls.find((c) => c.table === "os_notifications" && c.method === "GET")!;
  assert.match(String(read.query.get("kind")), /^in\./);
});

test("an admin who is also on the list sees everything", async () => {
  seed();
  process.env.ADMIN_EMAILS = `${ADMIN},${AMY}`;
  const b = await (await get(AMY)).json();
  process.env.ADMIN_EMAILS = ADMIN;
  assert.equal(b.capsOnly, false);
  assert.equal(b.items.length, 5);
});
