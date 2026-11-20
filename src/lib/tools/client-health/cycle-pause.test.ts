/*
 * The billing-cycle pause, end to end against the in-memory OS database. Client Health's clients, their cycles and
 * the campaign pause are fakes that record what they were asked: nothing here can reach EmailBison or Instantly.
 *
 * What is pinned:
 *   - without the switch it only says what it would do: no campaign touched, nothing written;
 *   - only an Active client at its due is acted on, never one billed per lead;
 *   - a campaign another client shares is left running;
 *   - once per cycle: a campaign a person resumes afterwards isn't paused again in that cycle; a new cycle is judged afresh;
 *   - a failed pause, or a status that couldn't be read, is tried again, and only that;
 *   - it refuses to act on anything less than the full picture.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../master-inbox/test/fake-postgrest.ts";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

type Live = { platform: "bison" | "instantly"; id: string; int_id: number | null; name: string; status: string };
const live = new Map<string, Live[]>();
const calls: string[] = [];
let failPause = false;
let unreadable = new Set<string>();

type FakeClient = {
  id: string; name: string; client_paused: boolean; per_lead: unknown; instantly_campaign_ids: string[]; bison_campaign_ids: string[];
  campaigns: { id: string; name: string; status: string }[]; bisonCampaigns: { id: string; name: string; status: string }[];
  cycle: { start: string; end: string; target: number; required: number; delivered: number } | null;
};
let clients: FakeClient[] = [];
let loadExtra: Record<string, unknown> = {};

const sending = (s: string) => ["active", "queued", "launching"].includes(s);
const withStatus = (c: Live) => (unreadable.has(c.id) ? { ...c, status: "unreachable" } : c);

mock.module("./loadDashboard", {
  namedExports: {
    loadDashboardClients: async () => ({ clients, allInstantlyCampaigns: [], allBisonCampaigns: [], source: "supabase", ...loadExtra }),
  },
});
mock.module("./per-lead", {
  namedExports: {
    healthSnapshot: (c: FakeClient) => (c.cycle
      ? { cycle: { ...c.cycle, start: new Date(`${c.cycle.start}T00:00:00Z`), end: new Date(`${c.cycle.end}T00:00:00Z`), carryIn: c.cycle.required - c.cycle.target, remaining: Math.max(0, c.cycle.required - c.cycle.delivered), index: 0 }, period: {}, status: "ok" }
      : null),
  },
});
mock.module("./weekly", { namedExports: { getWeekly: async () => ({ clients, now: new Date().toISOString() }) } });
mock.module("./campaign-toggle", {
  namedExports: {
    planToggle: async (chId: string) => {
      const all = (live.get(chId) ?? []).map(withStatus);
      return { clientId: chId, clientName: chId, action: "pause", willChange: all.filter((c) => sending(c.status)), skipped: all.filter((c) => !sending(c.status)).map((c) => ({ campaign: c, reason: c.status })) };
    },
    pauseListed: async (chId: string, list: Array<{ id: string }>, actor: string) => {
      calls.push(`pause ${chId} ${list.map((c) => c.id).join(",")} by ${actor}`);
      const mine = (live.get(chId) ?? []).filter((c) => list.some((l) => l.id === c.id)).map(withStatus);
      const will = mine.filter((c) => sending(c.status));
      const skipped = mine.filter((c) => !sending(c.status)).map((c) => ({ campaign: c, reason: c.status }));
      if (failPause) return { plan: { willChange: will, skipped }, outcomes: will.map((c) => ({ campaign: c, ok: false, error: "EmailBison said no" })), heldPaused: 0, held: [] };
      for (const c of will) (live.get(chId) ?? []).find((x) => x.id === c.id)!.status = "paused";
      return { plan: { willChange: will, skipped }, outcomes: will.map((c) => ({ campaign: c, ok: true })), heldPaused: 0, held: [] };
    },
  },
});

const { runCyclePauses, cycleProgress } = await import("./cycle-pause.ts");
const { MAX_TRIES } = await import("./cycle-pause-model.ts");

const ON = { OS_CYCLE_PAUSE: "1" };
const OFF = {};
const NOW = new Date("2026-11-20T15:00:00Z");
const OS_JC = "20000000-0000-4000-8000-000000000001";
const OS_LV = "20000000-0000-4000-8000-000000000002";
const OS_LA = "20000000-0000-4000-8000-000000000003";
const NOV = { start: "2026-11-03", end: "2026-12-01", target: 6, required: 6 };

/*
 * A client's introduction dates follow its cycle: `delivered` introductions, one every six hours from the day after
 * the cycle's last billing date (so the count Client Health shows and the one the pause times agree). A test that
 * wants other dates sets `intro_dates` itself.
 */
function client(id: string, name: string, o: Partial<FakeClient> & { intro_dates?: string[] } = {}): FakeClient {
  const c = {
    id, name, client_paused: false, per_lead: null, instantly_campaign_ids: [], bison_campaign_ids: (live.get(id) ?? []).map((x) => x.id),
    campaigns: [], bisonCampaigns: (live.get(id) ?? []).map((x) => ({ id: x.id, name: x.name, status: sending(x.status) ? "running" : "paused" })),
    cycle: { ...NOV, delivered: 6 }, ...o,
  } as FakeClient & { intro_dates?: string[] };
  if (!o.intro_dates) {
    Object.defineProperty(c, "intro_dates", {
      enumerable: true,
      configurable: true,
      get() {
        const cy = (this as FakeClient).cycle;
        if (!cy) return [];
        const from = Date.parse(`${cy.start}T00:00:00Z`) + 86_400_000;
        return Array.from({ length: cy.delivered }, (_, i) => new Date(from + i * 6 * 3_600_000).toISOString());
      },
    });
  }
  return c;
}

/** When the pause was switched on in these tests: before every cycle's introductions. */
const SINCE = "2026-11-01T00:00:00.000Z";
/** A live run, as if it has been running all along (switched on at SINCE, last run five minutes ago). */
function liveAt(now: Date) {
  if (!db.missingTables.has("os_cycle_pause_state")) db.seed("os_cycle_pause_state", [{ id: "default", live_since: SINCE, last_live_run_at: new Date(now.getTime() - 5 * 60_000).toISOString() }]);
  return { env: ON, now };
}

function seed(o: { jc?: Partial<FakeClient>; status?: string; records?: boolean } = {}) {
  db.reset();
  calls.length = 0;
  failPause = false;
  unreadable = new Set();
  loadExtra = {};
  live.clear();
  live.set("ch-jc", [
    { platform: "bison", id: "b1", int_id: 1, name: "Jeff Cook + Greenville", status: "active" },
    { platform: "bison", id: "b2", int_id: 2, name: "Jeff Cook + Spartanburg", status: "active" },
    { platform: "bison", id: "b3", int_id: 3, name: "Jeff Cook + Old", status: "paused" },
  ]);
  live.set("ch-lv", [{ platform: "bison", id: "b9", int_id: 9, name: "DE LV + LA", status: "active" }]);
  clients = [
    client("ch-jc", "Jeff Cook Real Estate", o.jc),
    client("ch-lv", "Douglas Elliman Las Vegas", { cycle: { ...NOV, delivered: 2 } }),
    // Linked to b9 as well: a shared campaign.
    { ...client("ch-la", "Douglas Elliman Los Angeles", { cycle: null }), bison_campaign_ids: ["b9"] },
  ];
  db.seed("os_clients", [
    { id: OS_JC, name: "Jeff Cook Real Estate", status: o.status ?? "active", ch_client_id: "ch-jc", an_client_id: "an-jc" },
    { id: OS_LV, name: "Douglas Elliman Las Vegas", status: "active", ch_client_id: "ch-lv", an_client_id: "an-lv" },
    { id: OS_LA, name: "Douglas Elliman Los Angeles", status: "active", ch_client_id: "ch-la", an_client_id: "an-la" },
  ]);
  if (o.records === false) db.missingTables.add("os_cycle_pauses");
  else db.seed("os_cycle_pauses", []);
}

const records = () => db.rows("os_cycle_pauses") as Array<Record<string, unknown>>;
const statusOf = (ch: string, id: string) => live.get(ch)!.find((c) => c.id === id)!.status;

test("without the switch it only says what it would do: nothing paused, nothing written", async () => {
  seed();
  const r = await runCyclePauses({ env: OFF, now: NOW, dryRunSince: SINCE });
  assert.equal(r.live, false);
  assert.equal(r.reached, 1);
  assert.deepEqual(calls, []);
  assert.equal(records().length, 0);
  assert.equal(db.writes("os_cycle_pauses", "POST").length + db.writes("os_cycle_pauses", "PATCH").length, 0);
  assert.match(r.notes.join(" | "), /Jeff Cook Real Estate: 6 of 6 since Nov 3, due Dec 1, would pause Jeff Cook \+ Greenville, Jeff Cook \+ Spartanburg/);
  assert.equal(statusOf("ch-jc", "b1"), "active");
});

test("at its due it pauses every sending campaign of the client, records it, and leaves the client below its due alone", async () => {
  seed();
  const r = await runCyclePauses(liveAt(NOW));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(calls, ["pause ch-jc b1,b2 by billing cycle target"]);
  assert.equal(r.paused, 2);
  assert.equal(statusOf("ch-jc", "b1"), "paused");
  assert.equal(statusOf("ch-lv", "b9"), "active");
  const [row] = records();
  assert.equal(row.os_client_id, OS_JC);
  assert.equal(row.cycle_start, "2026-11-03");
  assert.equal(row.cycle_end, "2026-12-01");
  assert.equal(row.required, 6);
  assert.equal(row.delivered, 6);
  assert.deepEqual((row.paused as Array<{ id: string }>).map((c) => c.id), ["b1", "b2"]);
  assert.deepEqual(row.to_retry, []);
});

test("once per cycle: a campaign a person resumes afterwards keeps running for the rest of the cycle", async () => {
  seed();
  await runCyclePauses(liveAt(NOW));
  live.get("ch-jc")!.find((c) => c.id === "b1")!.status = "active"; // a person pressed Resume
  calls.length = 0;
  const r = await runCyclePauses(liveAt(new Date("2026-11-21T15:00:00Z")));
  assert.deepEqual(calls, []);
  assert.equal(r.paused, 0);
  assert.equal(statusOf("ch-jc", "b1"), "active");
  assert.equal(records().length, 1);
});

test("a new cycle is judged afresh: below its due nothing happens, at it the campaigns pause again", async () => {
  seed();
  await runCyclePauses(liveAt(NOW));
  for (const c of live.get("ch-jc")!) c.status = "active"; // resumed by a person
  clients[0].cycle = { start: "2026-12-01", end: "2026-12-29", target: 6, required: 6, delivered: 3 };
  calls.length = 0;
  await runCyclePauses(liveAt(new Date("2026-12-05T15:00:00Z")));
  assert.deepEqual(calls, []);
  clients[0].cycle = { ...clients[0].cycle, delivered: 6 };
  await runCyclePauses(liveAt(new Date("2026-12-20T15:00:00Z")));
  assert.deepEqual(calls, ["pause ch-jc b1,b2,b3 by billing cycle target"]);
  assert.equal(records().length, 2);
});

test("measures against the due with the carried shortfall", async () => {
  seed({ jc: { cycle: { ...NOV, required: 8, delivered: 7 } } });
  await runCyclePauses(liveAt(NOW));
  assert.deepEqual(calls, []);
  assert.equal(records().length, 0);
});

test("only an Active client: onboarding, paused or churned is left alone", async () => {
  for (const status of ["onboarding", "paused", "churned"]) {
    seed({ status });
    const r = await runCyclePauses(liveAt(NOW));
    assert.deepEqual(calls, [], status);
    assert.equal(r.reached, 0, status);
  }
});

test("a client billed per lead is left to Lead caps, and one marked paused or with no target is left alone", async () => {
  for (const jc of [{ per_lead: { anchor: "2026-10-28" } }, { client_paused: true }, { cycle: { ...NOV, target: 0, required: 0, delivered: 4 } }, { cycle: null }]) {
    seed({ jc });
    await runCyclePauses(liveAt(NOW));
    assert.deepEqual(calls, [], JSON.stringify(jc));
  }
});

test("a campaign another client is linked to is left running, and recorded", async () => {
  seed();
  clients[1].cycle = { ...NOV, delivered: 6 }; // Las Vegas at its due; b9 is Los Angeles's too
  const r = await runCyclePauses(liveAt(NOW));
  assert.equal(statusOf("ch-lv", "b9"), "active");
  assert.ok(!calls.some((c) => c.startsWith("pause ch-lv")));
  const lv = records().find((x) => x.os_client_id === OS_LV)!;
  assert.deepEqual(lv.left_running, [{ platform: "bison", id: "b9", int_id: 9, name: "DE LV + LA", reason: "also linked to Douglas Elliman Los Angeles" }]);
  assert.equal(r.leftRunning, 1);
});

test("a failed pause is tried again on the next run, and only that", async () => {
  seed();
  failPause = true;
  await runCyclePauses(liveAt(NOW));
  const [row] = records();
  assert.deepEqual((row.to_retry as Array<{ id: string; error: string }>).map((c) => [c.id, c.error]), [["b1", "EmailBison said no"], ["b2", "EmailBison said no"]]);
  assert.equal(statusOf("ch-jc", "b1"), "active");
  failPause = false;
  calls.length = 0;
  await runCyclePauses(liveAt(new Date("2026-11-20T15:15:00Z")));
  assert.deepEqual(calls, ["pause ch-jc b1,b2 by billing cycle target"]);
  const [after] = records();
  assert.deepEqual(after.to_retry, []);
  assert.deepEqual((after.paused as Array<{ id: string }>).map((c) => c.id), ["b1", "b2"]);
  calls.length = 0;
  await runCyclePauses(liveAt(new Date("2026-11-20T15:30:00Z")));
  assert.deepEqual(calls, []);
});

test("a campaign whose status couldn't be read is tried again once it can be", async () => {
  seed();
  unreadable = new Set(["b2"]);
  await runCyclePauses(liveAt(NOW));
  assert.deepEqual(calls, ["pause ch-jc b1 by billing cycle target"]);
  assert.deepEqual((records()[0].to_retry as Array<{ id: string; error: string }>).map((c) => [c.id, c.error]), [["b2", "its status couldn't be read"]]);
  unreadable = new Set();
  calls.length = 0;
  await runCyclePauses(liveAt(new Date("2026-11-20T15:15:00Z")));
  assert.deepEqual(calls, ["pause ch-jc b2 by billing cycle target"]);
  assert.equal(statusOf("ch-jc", "b2"), "paused");
  assert.deepEqual(records()[0].to_retry, []);
});

test("a campaign on the retry list that has since been linked to another client too is left running, not paused", async () => {
  seed();
  failPause = true;
  await runCyclePauses(liveAt(NOW));
  failPause = false;
  // Name-linking has since put b1 on Las Vegas as well.
  clients[1].bison_campaign_ids = ["b9", "b1"];
  calls.length = 0;
  await runCyclePauses(liveAt(new Date("2026-11-20T15:15:00Z")));
  assert.deepEqual(calls, ["pause ch-jc b2 by billing cycle target"]);
  assert.equal(statusOf("ch-jc", "b1"), "active");
  const [row] = records();
  assert.deepEqual((row.left_running as Array<{ id: string; reason: string }>).map((c) => [c.id, c.reason]), [["b1", "also linked to Douglas Elliman Las Vegas"]]);
  assert.deepEqual(row.to_retry, []);
});

test("a campaign that keeps refusing is tried MAX_TRIES times, then left listed so the screens say so", async () => {
  seed();
  failPause = true;
  for (let i = 0; i < MAX_TRIES + 3; i++) await runCyclePauses(liveAt(new Date(NOW.getTime() + i * 15 * 60_000)));
  const tries = calls.filter((c) => c.startsWith("pause ch-jc")).length;
  assert.equal(tries, MAX_TRIES);
  const [row] = records();
  assert.ok((row.to_retry as Array<{ attempts: number }>).every((c) => c.attempts === MAX_TRIES));
  const v = await cycleProgress(ON);
  assert.equal(v.clients.find((c) => c.chClientId === "ch-jc")!.toRetry.length, 2);
});

test("another run that claimed the cycle first wins: this one pauses nothing", async () => {
  seed();
  db.failWhen = ({ method, table }) => (method === "POST" && table === "os_cycle_pauses" ? { code: "23505", message: "duplicate key", status: 409 } : false);
  const r = await runCyclePauses(liveAt(NOW));
  assert.deepEqual(calls, []);
  assert.deepEqual(r.errors, []);
});

test("it refuses to act on less than the full picture", async () => {
  for (const extra of [{ source: "seed" }, { error: "Client Health is down" }, { perLeadError: "usage billing unreadable" }, { datesUnsure: "Stripe could not be read" }]) {
    seed();
    loadExtra = extra;
    const r = await runCyclePauses(liveAt(NOW));
    assert.deepEqual(calls, [], JSON.stringify(extra));
    assert.equal(r.errors.length, 1, JSON.stringify(extra));
  }
});

test("live, without its table (migration 0054) it pauses nothing; a dry run still reports", async () => {
  seed({ records: false });
  const r = await runCyclePauses(liveAt(NOW));
  assert.deepEqual(calls, []);
  assert.match(r.errors[0], /migration 0054/);
  const dry = await runCyclePauses({ env: OFF, now: NOW, dryRunSince: SINCE });
  assert.deepEqual(dry.errors, []);
  assert.equal(dry.reached, 1);
});

test("a Client Health client two OS clients point at is left alone", async () => {
  seed();
  db.seed("os_clients", [...db.rows("os_clients"), { id: "20000000-0000-4000-8000-000000000009", name: "Jeff Cook (old)", status: "active", ch_client_id: "ch-jc" }]);
  const r = await runCyclePauses(liveAt(NOW));
  assert.deepEqual(calls, []);
  assert.match(r.errors.join(" "), /two OS clients/);
});

test("the screens get each client's cycle and what the pause did", async () => {
  seed();
  const before = await cycleProgress(OFF, { dryRunSince: SINCE });
  assert.equal(before.live, false);
  assert.equal(before.recordsReady, true);
  const jc = before.clients.find((c) => c.chClientId === "ch-jc")!;
  assert.deepEqual([jc.state, jc.analyticsClientId, jc.lastBilling, jc.nextBilling, jc.delivered, jc.required], ["reached", "an-jc", "2026-11-03", "2026-12-01", 6, 6]);
  assert.equal(before.clients.find((c) => c.chClientId === "ch-lv")!.state, "below");
  assert.deepEqual([before.clients.find((c) => c.chClientId === "ch-la")!.state, before.clients.find((c) => c.chClientId === "ch-la")!.why], ["skipped", "no billing date"]);
  await runCyclePauses(liveAt(new Date()));
  const after = await cycleProgress(ON);
  const jc2 = after.clients.find((c) => c.chClientId === "ch-jc")!;
  assert.equal(jc2.state, "paused");
  assert.deepEqual(jc2.paused.map((c) => c.id), ["b1", "b2"]);
});

/* ---------------------- only clients reaching their due AFTER it is switched on (the team, 20 Nov) ---------------------- */

const stateRow = () => db.rows("os_cycle_pause_state")[0] as { live_since: string; last_live_run_at: string } | undefined;

test("first live run: a client already at its due is left to the team (not paused), and the switch-on time is written", async () => {
  seed();
  db.seed("os_cycle_pause_state", []);
  const r = await runCyclePauses({ env: ON, now: NOW });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(calls, [], "Jeff Cook reached 6 of 6 on Nov 5, before the switch-on: never paused");
  assert.equal(records().length, 0);
  assert.equal(stateRow()?.live_since, NOW.toISOString());
  assert.equal(stateRow()?.last_live_run_at, NOW.toISOString());
});

test("a client that reaches its due after the switch-on is paused at the next run", async () => {
  seed({ jc: { cycle: { ...NOV, delivered: 5 } } });
  db.seed("os_cycle_pause_state", []);
  await runCyclePauses({ env: ON, now: NOW });                                  // switched on: Jeff Cook at 5 of 6
  assert.deepEqual(calls, []);
  // The sixth introduction comes in 10 minutes later.
  (clients[0] as FakeClient & { intro_dates?: string[] }).cycle = { ...NOV, delivered: 6 };
  Object.defineProperty(clients[0], "intro_dates", { value: [...Array.from({ length: 5 }, (_, i) => new Date(Date.parse("2026-11-04T00:00:00Z") + i * 6 * 3_600_000).toISOString()), "2026-11-20T15:10:00.000Z"], configurable: true });
  await runCyclePauses({ env: ON, now: new Date("2026-11-20T15:15:00Z") });
  assert.deepEqual(calls, ["pause ch-jc b1,b2 by billing cycle target"]);
  assert.equal(stateRow()?.live_since, NOW.toISOString(), "the switch-on time is kept while it runs");
});

test("off for over an hour, then on again: it starts afresh, and a client that reached its due meanwhile is left to the team", async () => {
  seed({ jc: { cycle: { ...NOV, delivered: 6 } } });
  // Was on until Nov 18, then off; Jeff Cook's sixth introduction came on Nov 19.
  db.seed("os_cycle_pause_state", [{ id: "default", live_since: SINCE, last_live_run_at: "2026-11-18T12:00:00.000Z" }]);
  Object.defineProperty(clients[0], "intro_dates", { value: ["2026-11-04T10:00:00Z", "2026-11-05T10:00:00Z", "2026-11-06T10:00:00Z", "2026-11-07T10:00:00Z", "2026-11-08T10:00:00Z", "2026-11-19T10:00:00Z"], configurable: true });
  await runCyclePauses({ env: ON, now: NOW });
  assert.deepEqual(calls, []);
  assert.equal(stateRow()?.live_since, NOW.toISOString(), "switched on again: now");
});

test("when it reached its due can't be told (introductions without dates): treated as before the switch-on, never paused on a guess", async () => {
  seed();
  Object.defineProperty(clients[0], "intro_dates", { value: [], configurable: true });
  await runCyclePauses(liveAt(NOW));
  assert.deepEqual(calls, []);
});

test("a dry run never writes the switch-on time, and its log says who would be left to the team", async () => {
  seed();
  db.seed("os_cycle_pause_state", []);
  const r = await runCyclePauses({ env: OFF, now: NOW });
  assert.equal(db.rows("os_cycle_pause_state").length, 0);
  assert.equal(db.writes("os_cycle_pause_state", "POST").length + db.writes("os_cycle_pause_state", "PATCH").length, 0);
  assert.match(r.notes.join(" | "), /Jeff Cook Real Estate: 6 of 6 since Nov 3, due Dec 1, reached Nov \d+, before the switch-on: left to the team/);
});

test("the switch-on time can't be read: nothing is paused", async () => {
  seed();
  db.missingTables.add("os_cycle_pause_state");
  const r = await runCyclePauses({ env: ON, now: NOW });
  assert.deepEqual(calls, []);
  assert.match(r.errors.join(" "), /when it was switched on is unknown/);
});

test("the screens mark a client at its due before the switch-on as left to the team", async () => {
  seed();
  db.seed("os_cycle_pause_state", [{ id: "default", live_since: "2026-11-10T00:00:00.000Z", last_live_run_at: new Date().toISOString() }]);
  const v = await cycleProgress(ON);
  const jc = v.clients.find((c) => c.chClientId === "ch-jc")!;
  assert.equal(jc.state, "before");
  assert.ok(jc.reachedAt && jc.reachedAt < "2026-11-10", String(jc.reachedAt));
});
