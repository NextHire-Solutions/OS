/*
 * The Leads tab's route and the Location filter (13 Oct, analytics 097).
 *
 * The filtering is SQL and is tested against a real Postgres. What can go
 * wrong HERE is quieter, and each case below is one of those:
 *
 *   · sending the new argument when no city is chosen. Before 097 runs the
 *     functions have no `p_loc`; a request carrying it matches no function,
 *     and every Leads tab would silently drop to the fallback — losing the
 *     Introduced status and the Sales volume filter for everyone.
 *   · answering UNFILTERED when the filter cannot be applied. A table that
 *     looks filtered and is not is how the wrong 400 leads get removed.
 *   · letting the address name an attribute of its own.
 *
 * The route runs for real; only its two outside readers are replaced — the
 * Analytics database client (recorded, answered from a script) and the
 * Master Inbox lookup of who has been introduced.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

type Call = { fn: string; args: Record<string, unknown> };
const calls: Call[] = [];
/** What each function answers; a function not listed answers "does not exist" (PGRST202). */
let answers: Record<string, unknown> = {};
const MISSING = { code: "PGRST202", message: "Could not find the function public.x in the schema cache" };

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

type Get = (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>;
let GET: Get | null = null;
if (canMock) {
  for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});
  mock.module("../../../../../../../lib/tools/analytics/supabase.ts", {
    namedExports: {
      analyticsTeamId: () => 2,
      getAnalyticsSupabase: () => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          return fn in answers ? { data: answers[fn], error: null } : { data: null, error: MISSING };
        },
      }),
    },
  });
  mock.module("../../../../../../../lib/tools/analytics/campaigns/introduced.ts", {
    namedExports: { campaignIntroductions: async () => ({ leadIds: [7], emails: ["a@b.co"] }) },
  });
  ({ GET } = (await import("./route.ts")) as unknown as { GET: Get });
}

const EB = "264";
const INSTANTLY = "0b4c2a3e-0000-4000-8000-000000000000";
const ROW = {
  lead_id: 1, email: "x@y.co", first_name: "X", last_name: "Y", company: null, title: null, lead_status: null,
  status: "contacted", step_reached: 1, sends: 1, first_sent_at: null, last_sent_at: null, opens: 0, unique_opens: 0,
  clicks: 0, replies: 0, positive: 0, bounces: 0, sender_email: null, attributes: { "office city": "Valencia, CA" }, total_count: 1,
};
/** The database after 097: every OS function exists. */
const AFTER_097 = {
  analytics_os_campaign_lead_rows: [ROW],
  analytics_os_campaign_lead_ids: [1],
  analytics_os_campaign_lead_facets: [],
  analytics_os_campaign_lead_locations: { "office city": [{ value: "Valencia, CA", leads: 406 }], "home city": [], "top producing city": [] },
  analytics_os_instantly_lead_rows: [],
  analytics_os_instantly_lead_ids: [],
};

async function get(id: string, query: string, db: Record<string, unknown> = AFTER_097) {
  calls.length = 0;
  answers = db;
  const res = await GET!(new NextRequest(`http://os.test/api/tools/analytics/campaigns/${id}/leads?${query}`), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const called = (fn: string) => calls.filter((c) => c.fn === fn);
const CITY = "loc_office=Valencia%2C%20CA&loc_office=Palmdale%2C%20CA&loc_top=Lancaster%2C%20CA";

test("no city chosen: the new argument is NOT sent — not as null, not at all", { skip }, async () => {
  for (const query of ["page=1", "page=1&q=woodland%20hills&status=replied&sort=name&dir=asc", "page=2&vmin=3000000", "ids=1&q=smith"]) {
    const r = await get(EB, query);
    assert.equal(r.status, 200, query);
    for (const c of calls) assert.equal("p_loc" in c.args, false, `${c.fn} was sent p_loc for ?${query}`);
  }
});

test("cities chosen: they reach the rows as p_loc, keyed by the attribute each field reads", { skip }, async () => {
  const r = await get(EB, `page=1&${CITY}`);
  assert.equal(r.status, 200);
  const [rows] = called("analytics_os_campaign_lead_rows");
  assert.deepEqual(rows.args.p_loc, { "office city": ["Valencia, CA", "Palmdale, CA"], "top producing city": ["Lancaster, CA"] });
  // Everything else about the request is as it was.
  assert.equal(rows.args.p_campaign_id, 264);
  assert.deepEqual(rows.args.p_intro_lead_ids, [7]);
});

test("…and reach 'Select all matching' the same way, so it selects what the table shows", { skip }, async () => {
  const r = await get(EB, `ids=1&q=gmail&status=completed&vmin=1000000&${CITY}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { leadIds: [1], total: 1 });
  const [ids] = called("analytics_os_campaign_lead_ids");
  assert.deepEqual(ids.args.p_loc, { "office city": ["Valencia, CA", "Palmdale, CA"], "top producing city": ["Lancaster, CA"] });
  assert.equal(ids.args.p_search, "gmail");
  assert.deepEqual(ids.args.p_status, ["completed"]);
  assert.equal(ids.args.p_attr_min, 1000000);
});

test("the address cannot name an attribute of its own", { skip }, async () => {
  await get(EB, "page=1&loc_phone=555&loc=Valencia&p_loc=%7B%7D&loc_home=Newhall%2C%20CA");
  assert.deepEqual(called("analytics_os_campaign_lead_rows")[0].args.p_loc, { "home city": ["Newhall, CA"] });
});

/** The database BEFORE 097: the 096 functions refuse a call that carries p_loc; the originals exist. */
const before097 = (): Record<string, unknown> => ({
  analytics_campaign_lead_rows: [{ ...ROW, lead_id: 999 }],
  analytics_campaign_lead_ids: [999],
  analytics_campaign_lead_facets: [],
});

test("cities chosen before 097 has run: refused in plain words — never answered unfiltered", { skip }, async () => {
  for (const query of [`page=1&${CITY}`, `ids=1&${CITY}`, `page=1&vmin=3000000&${CITY}`]) {
    const r = await get(EB, query, before097());
    assert.equal(r.status, 503, query);
    assert.match(String(r.body.error), /Location filter isn't switched on yet/);
    assert.equal("rows" in r.body || "leadIds" in r.body, false, "no rows, no ids");
    // The originals take no cities; falling back to them would return every lead.
    assert.equal(called("analytics_campaign_lead_rows").length + called("analytics_campaign_lead_ids").length, 0, "fell back to the unfiltered originals");
  }
});

test("no city chosen before the OS functions exist: the tab still falls back, as it always has", { skip }, async () => {
  const r = await get(EB, "page=1", before097());
  assert.equal(r.status, 200);
  assert.equal((r.body.rows as Array<{ leadId: number }>)[0].leadId, 999);
  assert.equal(r.body.introducedLive, false);
});

test("the cities to choose from: one call, the three fields, returned as sent", { skip }, async () => {
  const r = await get(EB, "locations=1");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { locations: AFTER_097.analytics_os_campaign_lead_locations });
  assert.equal(calls.length, 1, "nothing else is read — not the rows, not who was introduced");
  assert.deepEqual(calls[0], { fn: "analytics_os_campaign_lead_locations", args: { p_team_id: 2, p_campaign_id: 264, p_names: ["office city", "home city", "top producing city"] } });
});

test("the cities before 097 has run: a plain 'not switched on yet'", { skip }, async () => {
  const r = await get(EB, "locations=1", before097());
  assert.equal(r.status, 503);
  assert.match(String(r.body.error), /Location filter isn't switched on yet/);
});

test("an Instantly campaign has no lead attributes: no cities offered, and none sent", { skip }, async () => {
  const offered = await get(INSTANTLY, "locations=1");
  assert.deepEqual(offered.body, { locations: {} });
  assert.equal(calls.length, 0);
  const rows = await get(INSTANTLY, `page=1&${CITY}`);
  assert.equal(rows.status, 200);
  for (const c of calls) assert.equal("p_loc" in c.args, false, c.fn);
});

test("an Instantly campaign is never refused over cities it cannot have", { skip }, async () => {
  // City parameters on an Instantly address (a stale link, a copied URL) are
  // ignored — not turned into "the Location filter isn't switched on".
  const r = await get(INSTANTLY, `ids=1&${CITY}`, { analytics_instantly_lead_ids: ["a"] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { leadIds: ["a"], total: 1 });
});

test("a database error on the cities is reported, not swallowed into an empty list", { skip }, async () => {
  calls.length = 0;
  // An error that is NOT "function missing".
  const res = await (async () => {
    answers = {};
    const original = MISSING.code;
    MISSING.code = "57014"; MISSING.message = "canceling statement due to statement timeout";
    try {
      const r = await GET!(new NextRequest(`http://os.test/api/tools/analytics/campaigns/${EB}/leads?locations=1`), { params: Promise.resolve({ id: EB }) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    } finally {
      MISSING.code = original; MISSING.message = "Could not find the function public.x in the schema cache";
    }
  })();
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /timeout/);
});
