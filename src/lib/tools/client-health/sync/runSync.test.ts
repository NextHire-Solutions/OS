/*
 * The sync worker's pure parts, without a database or a network.
 *
 * What is worth asserting is what the tool's cron used to guarantee silently:
 * the exact row each source writes, the two short-circuit rules, and the
 * Corofy bucketing that turns a feed of intros into per-week and per-cycle
 * counts. A drift in any of these would show up as two dashboards disagreeing
 * about a client's numbers — the failure the proxy existed to prevent.
 *
 *   node --import ./scripts/alias-hooks.mjs --test src/lib/tools/client-health/sync/runSync.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  backfillWindow,
  bisonCampaignRow,
  bisonConfigured,
  weeklySourceUpserts,
  bucketByNameWeek,
  clientIntroCounts,
  introDates,
  corofyConfigured,
  deriveStatusChangedAt,
  instantlyCampaignRow,
  interestedByCampaign,
  labelWeeklyUpserts,
  newRunContext,
  normalizeClientName,
  runBison,
  runCorofy,
} from "./runSync.ts";
import { HISTORICAL_WEEKS } from "../types.ts";

const NOW = new Date("2026-09-15T14:00:00.000Z"); // a Tuesday

/** A database that fails the test the moment anything touches it. */
const untouchable = new Proxy({}, {
  get(_t, prop) {
    throw new Error(`database touched: ${String(prop)}`);
  },
}) as unknown as SupabaseClient;

const ENV = [
  "CLIENT_HEALTH_BISON_API_KEY",
  "CLIENT_HEALTH_COROFY_ADMIN_TOKEN",
  "CLIENT_HEALTH_COROFY_BASE_URL",
];
const saved = new Map(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// -- short-circuit rules -----------------------------------------------------

test("runBison skips, touching nothing, when BISON_API_KEY is empty", async () => {
  delete process.env.CLIENT_HEALTH_BISON_API_KEY;
  const ctx = newRunContext({ db: untouchable, now: NOW });
  assert.deepEqual(await runBison(ctx), { ok: true, skipped: true });

  process.env.CLIENT_HEALTH_BISON_API_KEY = "   ";
  assert.deepEqual(await runBison(ctx), { ok: true, skipped: true }, "whitespace is empty");
});

test("runCorofy skips when EITHER Corofy variable is empty", async () => {
  const ctx = newRunContext({ db: untouchable, now: NOW });

  delete process.env.CLIENT_HEALTH_COROFY_ADMIN_TOKEN;
  process.env.CLIENT_HEALTH_COROFY_BASE_URL = "https://corofy.example";
  assert.deepEqual(await runCorofy(ctx), { ok: true, skipped: true });

  process.env.CLIENT_HEALTH_COROFY_ADMIN_TOKEN = "tok";
  delete process.env.CLIENT_HEALTH_COROFY_BASE_URL;
  assert.deepEqual(await runCorofy(ctx), { ok: true, skipped: true });
});

test("the configured() rules read exactly the tool's variables", () => {
  const env = (map: Record<string, string>) => (k: string) => map[k];
  assert.equal(bisonConfigured(env({})), false);
  assert.equal(bisonConfigured(env({ CLIENT_HEALTH_BISON_API_KEY: "k" })), true);
  assert.equal(corofyConfigured(env({ CLIENT_HEALTH_COROFY_ADMIN_TOKEN: "t" })), false);
  assert.equal(corofyConfigured(env({ CLIENT_HEALTH_COROFY_BASE_URL: "u" })), false);
  assert.equal(
    corofyConfigured(env({ CLIENT_HEALTH_COROFY_ADMIN_TOKEN: "t", CLIENT_HEALTH_COROFY_BASE_URL: "u" })),
    true,
  );
});

// -- the backfill window -----------------------------------------------------

test("the backfill window is HISTORICAL_WEEKS Mondays ending this week", () => {
  const { mondayKeys, rangeStart, rangeEnd } = backfillWindow(NOW);
  assert.equal(mondayKeys.length, HISTORICAL_WEEKS);
  assert.equal(mondayKeys.at(-1), "2026-09-14", "the current week's Monday is last");
  assert.equal(rangeStart, mondayKeys[0]);
  assert.equal(rangeEnd, "2026-09-20", "range ends on this week's Sunday");
  for (const k of mondayKeys) assert.equal(new Date(`${k}T00:00:00Z`).getUTCDay(), 1, `${k} is a Monday`);
});

// -- status_changed_at -------------------------------------------------------

test("status_changed_at: a real transition stamps now", () => {
  assert.equal(deriveStatusChangedAt("paused", "running", null, "2026-01-01T00:00:00Z", NOW), NOW.toISOString());
});

test("status_changed_at: a first-seen paused campaign is seeded from the vendor's updated_at", () => {
  assert.equal(deriveStatusChangedAt("paused", undefined, undefined, "2026-01-01T00:00:00Z", NOW), "2026-01-01T00:00:00Z");
  assert.equal(deriveStatusChangedAt("finished", undefined, undefined, undefined, NOW), NOW.toISOString(), "no vendor stamp → now");
});

test("status_changed_at: unchanged status with a stamp on file is left alone", () => {
  assert.equal(deriveStatusChangedAt("paused", "paused", "2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z", NOW), undefined);
  assert.equal(deriveStatusChangedAt("running", undefined, undefined, "2026-01-01T00:00:00Z", NOW), undefined, "running is never seeded");
});

// -- row mapping: Instantly --------------------------------------------------

test("an instantly_campaigns row carries every column the tool writes", () => {
  const row = instantlyCampaignRow(
    { id: "c1", name: "Acme", status: 2, timestamp_updated: "2026-02-02T00:00:00Z" },
    {
      campaign_id: "c1", campaign_name: "Acme", campaign_status: 2,
      leads_count: 200, contacted_count: 150, emails_sent_count: 1234,
      new_leads_contacted_count: 0, reply_count: 40, reply_count_unique: 31,
      bounced_count: 5, completed_count: 150, total_opportunities: 0, total_opportunity_value: 0,
    },
    undefined,
    NOW,
  );
  assert.deepEqual(row, {
    id: "c1",
    name: "Acme",
    status: "paused",
    emails_sent_total: 1234,
    campaign_size: 200,
    progress_pct: 75,
    reply_count: 31,                       // unique preferred over total
    status_changed_at: "2026-02-02T00:00:00Z", // first-seen paused → vendor stamp
  });
});

test("an Instantly campaign with no analytics row writes zeros and no stamp", () => {
  const row = instantlyCampaignRow({ id: "c2", name: "Beta", status: 1 }, undefined, undefined, NOW);
  assert.deepEqual(row, {
    id: "c2", name: "Beta", status: "running",
    emails_sent_total: 0, campaign_size: 0, progress_pct: 0, reply_count: 0,
  });
  assert.ok(!("status_changed_at" in row), "undefined must not be sent as a column");
});

test("Instantly falls back to the analytics status and to total replies", () => {
  const row = instantlyCampaignRow(
    { id: "c3", name: "Gamma" },
    {
      campaign_id: "c3", campaign_name: "Gamma", campaign_status: 3,
      leads_count: 10, contacted_count: 10, emails_sent_count: 10,
      new_leads_contacted_count: 0, reply_count: 4,
      bounced_count: 0, completed_count: 12, total_opportunities: 0, total_opportunity_value: 0,
    },
    { status: "finished", status_changed_at: "2026-01-01T00:00:00Z" },
    NOW,
  );
  assert.equal(row.status, "finished");
  assert.equal(row.reply_count, 4);
  assert.equal(row.progress_pct, 100, "capped at 100");
  assert.ok(!("status_changed_at" in row));
});

// -- row mapping: Bison ------------------------------------------------------

test("a bison_campaigns row is keyed by uuid and keeps the integer id", () => {
  const row = bisonCampaignRow(
    {
      id: 55, uuid: "u-55", name: "Delta", status: "Completed",
      emails_sent: 900, total_leads: 300, total_leads_contacted: 290,
      replied: 20, unique_replies: 18, completion_percentage: 96.666,
      updated_at: "2026-03-03T00:00:00Z",
    },
    { status: "running", status_changed_at: null },
    NOW,
  );
  assert.deepEqual(row, {
    id: "u-55",
    int_id: 55,
    name: "Delta",
    status: "finished",
    emails_sent_total: 900,
    campaign_size: 300,
    progress_pct: 96.67,
    reply_count: 18,
    status_changed_at: NOW.toISOString(), // running → finished is a transition
  });
});

test("Bison progress derives from contacted/total when the vendor gives no percentage", () => {
  const row = bisonCampaignRow(
    { id: 1, uuid: "u-1", name: "E", status: "Launching", total_leads: 8, total_leads_contacted: 2, replied: 3 },
    undefined,
    NOW,
  );
  assert.equal(row.status, "running");
  assert.equal(row.progress_pct, 25);
  assert.equal(row.reply_count, 3, "total replied when unique_replies is absent");
  assert.ok(!("status_changed_at" in row));
});

// -- weekly rows: each source owns its columns, the total is derived -------
// (ported from shaurs 6837ce6 — the fix for the 17 Sep outage)

const W1 = "2026-09-07", W2 = "2026-09-14";
const src = (ei: number, ri: number, eb: number, rb: number) =>
  ({ emails_sent_instantly: ei, replies_instantly: ri, emails_sent_bison: eb, replies_bison: rb });

test("Bison writes ONLY its columns; the total is its figure plus Instantly's AS STORED", () => {
  const weekly = new Map([["b1", new Map([[W1, { sent: 10, replies: 1 }]])]]);
  const { upserts } = weeklySourceUpserts("bison", [{ id: "a", ids: ["b1"] }], [W1], weekly, new Set(), new Map([["a|" + W1, src(100, 7, 999, 99)]]));
  assert.deepEqual(upserts, [{ client_id: "a", week_key: W1, emails_sent_bison: 10, replies_bison: 1, emails_sent: 110, replies: 8 }]);
});

test("Instantly mirrors it: its columns, plus Bison's as stored", () => {
  const weekly = new Map([["i1", new Map([[W1, { sent: 40, replies: 3 }]])]]);
  const { upserts } = weeklySourceUpserts("instantly", [{ id: "a", ids: ["i1"] }], [W1], weekly, new Set(), new Map([["a|" + W1, src(999, 99, 10, 1)]]));
  assert.deepEqual(upserts, [{ client_id: "a", week_key: W1, emails_sent_instantly: 40, replies_instantly: 3, emails_sent: 50, replies: 4 }]);
});

test("running the same job twice gives the same total — the old design double-counted Bison", () => {
  const weekly = new Map([["b1", new Map([[W1, { sent: 10, replies: 1 }]])]]);
  const stored = new Map([["a|" + W1, src(100, 7, 0, 0)]]);
  const first = weeklySourceUpserts("bison", [{ id: "a", ids: ["b1"] }], [W1], weekly, new Set(), stored).upserts[0];
  stored.set("a|" + W1, src(100, 7, 10, 1)); // what the first run stored
  const second = weeklySourceUpserts("bison", [{ id: "a", ids: ["b1"] }], [W1], weekly, new Set(), stored).upserts[0];
  assert.equal(first.emails_sent, 110);
  assert.equal(second.emails_sent, 110);
});

test("a source's real zero is used as stored — never treated as 'never populated' (72,719 vs 42,668)", () => {
  const weekly = new Map([["b1", new Map([[W1, { sent: 5, replies: 0 }]])]]);
  const { upserts } = weeklySourceUpserts("bison", [{ id: "a", ids: ["b1"] }], [W1], weekly, new Set(), new Map([["a|" + W1, src(0, 0, 0, 0)]]));
  assert.equal(upserts[0].emails_sent, 5);
});

test("zero weeks are written, so a stopped campaign does not keep its last figure", () => {
  const weekly = new Map([["b1", new Map([[W1, { sent: 10, replies: 1 }]])]]);
  const { upserts } = weeklySourceUpserts("bison", [{ id: "a", ids: ["b1"] }], [W1, W2], weekly, new Set(), new Map());
  assert.deepEqual(upserts.map((u) => [u.week_key, u.emails_sent_bison]), [[W1, 10], [W2, 0]]);
});

test("a client with ANY unreadable campaign is skipped whole — a failed fetch is not zero sends", () => {
  const weekly = new Map([["b1", new Map([[W1, { sent: 10, replies: 1 }]])]]);
  const r = weeklySourceUpserts("bison", [{ id: "a", ids: ["b1", "b2"] }, { id: "b", ids: ["b1"] }], [W1], weekly, new Set(["b2"]), new Map());
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.upserts.map((u) => u.client_id), ["b"]);
});

test("Bison leaves clients with no Bison campaigns alone; Instantly writes every client", () => {
  const none = new Map<string, Map<string, { sent: number; replies: number }>>();
  assert.equal(weeklySourceUpserts("bison", [{ id: "a", ids: [] }], [W1], none, new Set(), new Map()).upserts.length, 0);
  assert.equal(weeklySourceUpserts("instantly", [{ id: "a", ids: [] }], [W1], none, new Set(), new Map()).upserts.length, 1);
});

test("a week with no stored row takes 0 for the other source", () => {
  const weekly = new Map([["i1", new Map([[W1, { sent: 7, replies: 2 }]])]]);
  const { upserts } = weeklySourceUpserts("instantly", [{ id: "a", ids: ["i1"] }], [W1], weekly, new Set(), new Map());
  assert.equal(upserts[0].emails_sent, 7);
});

// -- Corofy bucketing --------------------------------------------------------

test("alias names collapse to the primary client", () => {
  assert.equal(normalizeClientName("Properties & Estates Florida"), normalizeClientName("Properties & Estates"));
  assert.notEqual(normalizeClientName("Some Other Client"), normalizeClientName("Properties & Estates"));
});

test("intros bucket by normalized name and week, clipped to the window but not for all-time", () => {
  const valid = new Set(["2026-09-07", "2026-09-14"]);
  const b = bucketByNameWeek(
    [
      { client_name: "C21 Results - Elite Team", assigned_at: "2026-09-15T10:00:00Z" },
      { client_name: "C21 Results Elite Team", assigned_at: "2026-09-08T10:00:00Z" },
      { client_name: "C21 Results Elite Team", assigned_at: "2025-01-01T10:00:00Z" }, // outside the window
      { client_name: "Nobody", assigned_at: "not a date" },
    ],
    valid,
  );
  const key = normalizeClientName("C21 Results Elite Team");
  assert.deepEqual(b.byNameWeek.get(`${key}|2026-09-14`), { count: 1, latest: Date.parse("2026-09-15T10:00:00Z") });
  assert.deepEqual(b.byNameWeek.get(`${key}|2026-09-07`), { count: 1, latest: Date.parse("2026-09-08T10:00:00Z") });
  assert.equal(b.allTimeCount.get(key), 3, "all-time count includes the row outside the window");
  assert.equal(b.allTimeLatest.get(key), Date.parse("2026-09-15T10:00:00Z"));
  assert.equal(b.seenOriginalByNormalized.get(key), "C21 Results - Elite Team", "first spelling seen is kept for the warning");
  assert.equal(b.allTimeCount.has(normalizeClientName("Nobody")), false, "unparseable dates are dropped");
});

test("weekly label rows are emitted for EVERY client × week, zero included, with the all-time fallback timestamp", () => {
  const valid = new Set(["2026-09-07", "2026-09-14"]);
  const b = bucketByNameWeek(
    [{ client_name: "Acme", assigned_at: "2026-09-08T10:00:00Z" }],
    valid,
  );
  const rows = labelWeeklyUpserts(
    [{ id: "a", name: "Acme" }, { id: "z", name: "Zed" }],
    ["2026-09-07", "2026-09-14"],
    b,
    "intros_corofy",
    "last_corofy_intro_at",
  );
  assert.deepEqual(rows, [
    { client_id: "a", week_key: "2026-09-07", intros_corofy: 1, last_corofy_intro_at: "2026-09-08T10:00:00.000Z" },
    // No intro this week → count 0, timestamp falls back to the client's all-time latest.
    { client_id: "a", week_key: "2026-09-14", intros_corofy: 0, last_corofy_intro_at: "2026-09-08T10:00:00.000Z" },
    { client_id: "z", week_key: "2026-09-07", intros_corofy: 0, last_corofy_intro_at: null },
    { client_id: "z", week_key: "2026-09-14", intros_corofy: 0, last_corofy_intro_at: null },
  ]);
});

test("per-client cycle counts: since last billing, this month, stagnant, all-time", () => {
  // Biweekly from 2026-09-01: billing days 09-01, 09-15. At NOW (09-15 14:00)
  // the last billing day is 09-15 itself, so the current cycle starts 09-16 —
  // nothing counts as "since last billing" yet. Monthly cycle starts 09-01
  // inclusive.
  const counts = clientIntroCounts(
    [
      { client_name: "Acme", assigned_at: "2026-09-02T00:00:00Z", client_activity_at: null },
      { client_name: "Acme", assigned_at: "2026-09-10T00:00:00Z", client_activity_at: "2026-09-11T00:00:00Z" },
      { client_name: "Acme", assigned_at: "2026-08-20T00:00:00Z", client_activity_at: null },
    ],
    { billing_anchor_date: "2026-09-01", billing_interval: "biweekly", billing_interval_days: null, start_date: "2026-01-01" },
    NOW.getTime(),
  );
  assert.deepEqual(counts, {
    intros_since_last_billing: 0,
    stagnant_intros_count: 2,
    intros_this_month: 2,
    total_intros_corofy: 3,
  });
});

test("the billing day itself belongs to the OUTGOING cycle", () => {
  // Same anchor; at 09-16 the cycle that started 09-16 counts the intro on 09-16 but not 09-15.
  const at = new Date("2026-09-16T12:00:00Z").getTime();
  const counts = clientIntroCounts(
    [
      { client_name: "Acme", assigned_at: "2026-09-15T23:00:00Z" },
      { client_name: "Acme", assigned_at: "2026-09-16T01:00:00Z" },
    ],
    { billing_anchor_date: "2026-09-01", billing_interval: "biweekly", billing_interval_days: null, start_date: null },
    at,
  );
  assert.equal(counts.intros_since_last_billing, 1);
});

test("stagnant falls back to the updated_at heuristic when client_activity_at is absent", () => {
  const counts = clientIntroCounts(
    [
      { client_name: "Acme", assigned_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:01.000Z" }, // <2s → stagnant
      { client_name: "Acme", assigned_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-12T00:00:00.000Z" },
      { client_name: "Acme", assigned_at: "2026-09-10T00:00:00.000Z" },                                          // no signal → not counted
    ],
    { billing_anchor_date: null, billing_interval: null, billing_interval_days: null, start_date: null },
    NOW.getTime(),
  );
  assert.equal(counts.stagnant_intros_count, 1);
  assert.equal(counts.intros_since_last_billing, 0, "no anchor and no start date → no cycle");
});

test("Interested rows attribute to campaigns by the string Corofy sends", () => {
  const m = interestedByCampaign([
    { client_name: "A", assigned_at: "2026-09-01T00:00:00Z", campaign_id: "uuid-1" },
    { client_name: "A", assigned_at: "2026-09-01T00:00:00Z", campaign_id: "uuid-1" },
    { client_name: "A", assigned_at: "2026-09-01T00:00:00Z", campaign_id: "55" },
    { client_name: "A", assigned_at: "2026-09-01T00:00:00Z", campaign_id: null },
  ]);
  assert.deepEqual([...m.entries()], [["uuid-1", 2], ["55", 1]]);
});

test("intro_dates: every valid assigned_at, oldest first; junk dropped", () => {
  assert.deepEqual(
    introDates([
      { assigned_at: "2026-09-20T10:00:00Z" },
      { assigned_at: "not a date" },
      { assigned_at: "2026-09-02T00:00:00Z" },
      { assigned_at: "" },
      { assigned_at: "2026-09-15T23:59:00Z" },
    ]),
    ["2026-09-02T00:00:00Z", "2026-09-15T23:59:00Z", "2026-09-20T10:00:00Z"],
  );
  assert.deepEqual(introDates([]), []);
});

test("intro_dates is written by the Corofy pass as its OWN update, after the counters", async () => {
  // The billing views read clients.intro_dates. If it rode inside the counter
  // update, one bad column would freeze every billing figure; if the OS sync
  // stopped writing it, they would freeze on switch-over day (port doc §5).
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./runSync.ts", import.meta.url), "utf8");
  const counters = src.indexOf(".update(clientIntroCounts(clientIntros, c, nowMs))");
  const dates = src.indexOf(".update({ intro_dates: introDates(clientIntros) })");
  assert.ok(counters > 0 && dates > counters);
});
