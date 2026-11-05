/*
 * The Billing tab's cap actions, through the real route: the real signed cookie, the in-memory database, and the
 * campaign toggle faked so nothing can reach EmailBison. Same people as the rest of the tab; the panel failing never
 * takes the invoices with it.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest, type Row } from "../../../../../../lib/tools/master-inbox/test/fake-postgrest.ts";
import { mintSso } from "../../../../../../lib/bs-auth.ts";
import { easternDay } from "../../../../../../lib/clients/usage-billing/model.ts";

configureFakeEnvironment("MASTER_INBOX_");
process.env.AUTH_SECRET = "s".repeat(40);
process.env.OS_PUBLIC_URL = "https://os.test";
delete process.env.SSO_SESSIONS_NOT_BEFORE;
for (const v of ["OS_USAGE_BILLING_STRIPE_KEY", "OS_USAGE_BILLING_ENABLED", "OS_USAGE_BILLING_CHARGE"]) delete process.env[v];

const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

const live = [{ platform: "bison", id: "a", int_id: 1, name: "Acme + SoCal", status: "paused" }, { platform: "bison", id: "b", int_id: 2, name: "Acme + Boston", status: "paused" }];
const resumed: string[] = [];
let chFails = false;
let target: unknown = 2;
mock.module("../../../../../../lib/tools/client-health/campaign-toggle", {
  namedExports: {
    planToggle: async () => ({ willChange: [], skipped: [] }),
    liveCampaigns: async () => live.map((c) => ({ ...c })),
    sharedWithOthers: async () => new Map(),
    isSending: () => false,
    pauseListed: async () => { throw new Error("nothing pauses from these actions"); },
    resumeListed: async (_c: string, list: Array<{ id: string; name: string }>) => {
      resumed.push(...list.map((c) => c.id));
      return { plan: {}, outcomes: list.map((c) => ({ campaign: c, ok: true })), heldPaused: 0, held: [] };
    },
  },
});
mock.module("../../../../../../lib/tools/client-health/supabase", {
  namedExports: {
    getSupabase: () => ({
      from: () => {
        const b = { select: () => b, eq: () => b, maybeSingle: async () => (chFails ? { data: null, error: { message: "Client Health is down" } } : { data: { monthly_target: target }, error: null }) };
        return b;
      },
    }),
  },
});

const { GET, POST } = await import("./route.ts");

const ACME = "20000000-0000-4000-8000-000000000001";
const PORTAL = "10000000-0000-4000-8000-000000000001";
const ADMIN = "admin@outreachify.io";
// The leads below are two hours old: anchored on their day, so they are in this window whatever time the tests run.
const LEAD_AT = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
const THIS_WINDOW = easternDay(LEAD_AT);

function seed(o: { leads?: number } = {}) {
  db.reset();
  resumed.length = 0;
  chFails = false;
  target = 2;
  process.env.OS_LEAD_CAPS = "1";
  db.seed("os_clients", [{ id: ACME, name: "Acme Realty", aliases: [], status: "active", mi_client_id: PORTAL, ch_client_id: "ch1" }]);
  db.seed("clients", [{ id: PORTAL, name: "Acme Realty", slug: "acme", aliases: [] }]);
  db.seed("labels", [{ id: "lab-int", name: "Interested" }]);
  for (const t of ["os_usage_billing_periods", "os_brokerage_relays", "os_campaign_portals", "os_cap_windows", "os_cap_held_leads", "leads", "threads", "label_assignments", "label_history", "client_pipeline_entries"]) db.seed(t, []);
  db.seed("os_usage_billing_settings", [{
    os_client_id: ACME, enabled: false, test_only: false, price_cents: 25_000, every_days: 14, anchor_date: THIS_WINDOW, lead_source: "handoffs",
    stripe_customer_id: null, default_payment_method_id: null, card_label: null, setup_session_id: null, spend_cap_cents: null,
  }]);
  const at = LEAD_AT;
  for (let i = 0; i < (o.leads ?? 0); i += 1) {
    db.rows("leads").push({ id: `l${i}`, email: `a${i}@x.test`, full_name: `Agent ${i}` });
    db.rows("threads").push({ id: `t${i}`, client_id: PORTAL, lead_id: `l${i}`, status: "open" });
    db.rows("label_assignments").push({ label_id: "lab-int", target_type: "thread", target_id: `t${i}`, assigned_at: at });
    db.rows("label_history").push({ id: i + 1, thread_id: `t${i}`, label_id: "lab-int", label_name: "Interested", assigned_at: at, client_id: PORTAL, lead_id: `l${i}`, source: "trigger" });
  }
}

const cookie = async (email: string) => `bs_sso=${await mintSso(process.env.AUTH_SECRET!, { email, grants: ["clients", "inbox"], ver: 1 })}`;
async function get(who: string | null) {
  const headers: Record<string, string> = who ? { cookie: await cookie(who) } : {};
  return GET(new Request(`https://os.test/api/workspace/clients/billing/usage?clientId=${ACME}`, { headers }));
}
async function post(who: string | null, body: Record<string, unknown>) {
  const headers: Record<string, string> = { "content-type": "application/json", "sec-fetch-site": "same-origin", ...(who ? { cookie: await cookie(who) } : {}) };
  return POST(new Request("https://os.test/api/workspace/clients/billing/usage", { method: "POST", headers, body: JSON.stringify({ clientId: ACME, ...body }) }));
}

test("only the Billing tab's named people: anyone else gets a bare 404 and nothing is written", async () => {
  seed({ leads: 2 });
  for (const who of [null, "staff@brokerstaffer.com", "someone@outreachify.io"]) {
    for (const body of [{ action: "set_spend_cap", spendCap: "1000" }, { action: "cap_add_restart", platform: "bison", id: "a" }, { action: "cap_remove_restart", platform: "bison", id: "a" }, { action: "cap_restart" }]) {
      const r = await post(who, body);
      assert.equal(r.status, 404, `${who} ${body.action}`);
    }
  }
  assert.equal(db.rows("os_usage_billing_settings")[0].spend_cap_cents, null);
  assert.deepEqual(db.rows("os_cap_windows"), []);
  assert.deepEqual(resumed, []);
});

test("from another site: refused", async () => {
  seed();
  const headers = { "content-type": "application/json", "sec-fetch-site": "cross-site", cookie: await cookie(ADMIN) };
  const r = await POST(new Request("https://os.test/api/workspace/clients/billing/usage", { method: "POST", headers, body: JSON.stringify({ clientId: ACME, action: "set_spend_cap", spendCap: "1000" }) }));
  assert.equal(r.status, 403);
  assert.equal(db.rows("os_usage_billing_settings")[0].spend_cap_cents, null);
});

test("the tab shows the cap, and the same answer the run would give", async () => {
  seed({ leads: 2 });
  const g = await (await get(ADMIN)).json();
  assert.equal(g.cap.cap, 2);
  assert.equal(g.cap.used, 2);
  assert.equal(g.cap.reached, true);
  assert.equal(g.cap.live, true);
  assert.equal(g.cap.notActing, null);
  assert.equal(g.capError, null);
});

test("the switch off: the tab says so, and what moves a campaign is refused by the server, with the button or without", async () => {
  seed({ leads: 2 });
  delete process.env.OS_LEAD_CAPS;
  const g = await (await get(ADMIN)).json();
  assert.equal(g.cap.live, false);
  for (const body of [{ action: "cap_add_restart", platform: "bison", id: "a" }, { action: "cap_remove_restart", platform: "bison", id: "a" }, { action: "cap_restart" }]) {
    const r = await post(ADMIN, body);
    assert.equal(r.status, 409, body.action);
    assert.match(String((await r.json()).error), /aren't switched on/);
  }
  assert.deepEqual(db.rows("os_cap_windows"), []);
  assert.deepEqual(resumed, []);
  const saved = await post(ADMIN, { action: "set_spend_cap", spendCap: "1000" });
  assert.equal(saved.status, 200, "a limit saved ahead of time does nothing until it is on");
});

test("a client still in test: the tab says why its cap isn't acting, never that it's at its cap", async () => {
  seed({ leads: 2 });
  db.rows("os_usage_billing_settings")[0].test_only = true;
  const g = await (await get(ADMIN)).json();
  assert.match(String(g.cap.notActing), /still in test/);
  assert.equal(g.cap.reached, false);
  assert.equal(g.cap.used, 2);
});

test("the cap can't be read: the invoices still show, and the panel says why", async () => {
  seed();
  chFails = true;
  const res = await get(ADMIN);
  assert.equal(res.status, 200);
  const g = await res.json();
  assert.equal(g.cap, null);
  assert.match(String(g.capError), /Client Health is down/);
  assert.ok(g.settings);
});

test("the spend limit: saved, cleared, refused when it buys nothing, and never moves the price", async () => {
  seed();
  const ok = await (await post(ADMIN, { action: "set_spend_cap", spendCap: "1,000" })).json();
  assert.equal(ok.cap.spendCapCents, 100_000);
  assert.equal(ok.cap.spendLeads, 4);
  assert.equal(db.rows("os_usage_billing_settings")[0].price_cents, 25_000);
  assert.equal(db.rows("os_usage_billing_settings")[0].anchor_date, THIS_WINDOW);
  await post(ADMIN, { action: "set_spend_cap", spendCap: "" });
  assert.equal(db.rows("os_usage_billing_settings")[0].spend_cap_cents, null);
  const bad = await post(ADMIN, { action: "set_spend_cap", spendCap: "100" });
  assert.equal(bad.status, 400);
  assert.match(String((await bad.json()).error), /less than one lead/);
  assert.equal(db.rows("os_usage_billing_settings")[0].spend_cap_cents, null);
});

test("adding a person's paused campaign to the restart: at the cap only, this client's only", async () => {
  seed();
  assert.equal((await post(ADMIN, { action: "cap_add_restart", platform: "bison", id: "a" })).status, 409, "under the cap");
  seed({ leads: 2 });
  assert.equal((await post(ADMIN, { action: "cap_add_restart", platform: "bison", id: "not-linked" })).status, 404);
  const ok = await (await post(ADMIN, { action: "cap_add_restart", platform: "bison", id: "a" })).json();
  assert.deepEqual(ok.cap.waiting.map((c: Row) => c.id), ["a"]);
  assert.deepEqual(ok.cap.pausedOtherwise.map((c: Row) => c.id), ["b"]);
  assert.deepEqual(resumed, [], "listed, not restarted");
});

test("an action that worked and a panel that won't read back: still says it worked", async () => {
  seed({ leads: 2 });
  await post(ADMIN, { action: "cap_add_restart", platform: "bison", id: "a" });
  target = 5;
  let reads = 0;
  // restartNow reads Client Health once to decide; the failure is on the read back after it.
  const real = db.failWhen;
  db.failWhen = ({ method, table }) => method === "GET" && table === "os_cap_windows" && ++reads > 2;
  const r = await post(ADMIN, { action: "cap_restart" });
  db.failWhen = real;
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.cap, null);
  assert.deepEqual(resumed, ["a"]);
});

test("taking a campaign off the restart: it stays paused, and pressing it again says so", async () => {
  seed({ leads: 2 });
  await post(ADMIN, { action: "cap_add_restart", platform: "bison", id: "a" });
  const ok = await (await post(ADMIN, { action: "cap_remove_restart", platform: "bison", id: "a" })).json();
  assert.deepEqual(ok.cap.waiting, []);
  assert.equal((await post(ADMIN, { action: "cap_remove_restart", platform: "bison", id: "a" })).status, 404);
});

test("restart now: refused at the cap; with the cap raised, exactly what's listed", async () => {
  seed({ leads: 2 });
  await post(ADMIN, { action: "cap_add_restart", platform: "bison", id: "a" });
  const no = await post(ADMIN, { action: "cap_restart" });
  assert.equal(no.status, 409);
  assert.match(String((await no.json()).error), /at its cap/);
  assert.deepEqual(resumed, []);
  target = 5;
  const ok = await (await post(ADMIN, { action: "cap_restart" })).json();
  assert.equal(ok.restarted, 1);
  assert.deepEqual(resumed, ["a"]);
});
