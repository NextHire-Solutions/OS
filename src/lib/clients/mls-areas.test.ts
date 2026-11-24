/*
 * The area for each MLS (the client's request: "add a field to the client's Record tab to configure the area name
 * associated with each MLS"; os_clients.mls_areas, migration 0056) — a campaign made for one MLS fills {CLIENT_AREA}
 * with that MLS's area.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { configureFakeEnvironment, FakePostgrest } from "../tools/master-inbox/test/fake-postgrest.ts";
import { areaForMls, areaForMlsCode, cleanMlsAreas, mlsKey, readMlsAreas } from "./coverage.ts";

const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

configureFakeEnvironment("MASTER_INBOX_");
const db = new FakePostgrest();
globalThis.fetch = db.fetch as typeof fetch;
for (const m of ["log", "warn", "error", "info"] as const) mock.method(console, m, () => {});

/* The agent database's MLS boards (code and aliases). */
const BOARDS = [
  { id: "m1", code: "MLSPIN", name: "MLS Property Information Network", aliases: ["MLS PIN"] },
  { id: "m2", code: "BRIGHTMLS", name: "Bright MLS", aliases: ["Bright", "BRIGHT"] },
  { id: "m3", code: "SOCAL", name: "CRMLS", aliases: [] },
];

type Db = typeof import("./coverage-db.ts");
type Area = typeof import("./mls-area-db.ts");
let coverageDb: Db | null = null;
let mlsAreaDb: Area | null = null;
if (canMock) {
  mock.module("@/lib/crm-preview/market", { namedExports: { mlsCatalog: async () => BOARDS } });
  coverageDb = (await import("./coverage-db.ts")) as Db;
  mlsAreaDb = (await import("./mls-area-db.ts")) as Area;
}

test("an MLS compared as the agent database matches one: case, spaces and punctuation aside", () => {
  assert.equal(mlsKey("MLS PIN"), mlsKey("mlspin"));
  assert.equal(mlsKey("Bright-MLS"), "brightmls");
});

test("cleaning the map: only the client's MLSs, spelt as its list spells them; blanks dropped; long or non-text refused", () => {
  const mls = ["MLSPIN", "Bright"];
  assert.deepEqual(cleanMlsAreas({ mlspin: "  Greater   Boston ", BRIGHT: "Northern Virginia" }, mls), { value: { MLSPIN: "Greater Boston", Bright: "Northern Virginia" }, problems: [] });
  assert.deepEqual(cleanMlsAreas({ MLSPIN: "", Bright: null }, mls).value, {}, "a blank area takes that MLS's entry off");
  assert.match(cleanMlsAreas({ SOCAL: "San Diego" }, mls).problems.join(), /isn't one of this client's MLSs/);
  assert.match(cleanMlsAreas({ MLSPIN: "x".repeat(121) }, mls).problems.join(), /longer than 120 characters/);
  assert.match(cleanMlsAreas({ MLSPIN: 5 }, mls).problems.join(), /must be text/);
  assert.match(cleanMlsAreas(["MLSPIN"], mls).problems.join(), /list of MLS and area pairs/);
});

test("the area for an MLS: by code any way spelt, or through the agent database's aliases", () => {
  const map = { "MLS PIN": "Greater Boston", Bright: "Northern Virginia" };
  assert.equal(areaForMls(map, "mlspin"), "Greater Boston");
  assert.equal(areaForMls(map, "SOCAL"), null);
  assert.equal(areaForMlsCode(map, "BRIGHTMLS", []), null, "without the boards, an alias can't be matched");
  assert.equal(areaForMlsCode(map, "BRIGHTMLS", BOARDS), "Northern Virginia", "the setup campaign's code (BRIGHTMLS), the client's spelling (Bright)");
  assert.equal(areaForMlsCode(map, "SOCAL", BOARDS), null);
  assert.deepEqual(readMlsAreas({ A: " x ", B: "", C: 3 }), { A: "x" });
  assert.deepEqual(readMlsAreas(null), {});
});

function seed(mlsAreas: unknown = {}) {
  db.reset();
  db.seed("os_clients", [
    { id: "os-homebase", name: "Homebase", market_count: 2, mls_codes: ["MLS PIN", "SOCAL"], areas: ["Greater Boston", "San Diego County"], mls_areas: mlsAreas },
    { id: "os-one", name: "One Market Co", market_count: 1, mls_codes: ["REcolorado"], areas: ["Greater Denver"], mls_areas: {} },
  ]);
  db.seed("os_setup_campaigns", [{ os_client_id: "os-homebase", mls_code: "MLSPIN", campaign_id: "950", status: "ready", portal_id: "p", template_campaign_id: "42", created_by: "x" }]);
  db.seed("os_campaign_list_clients", [{ os_client_id: "os-homebase", prospects_by_mls: { SOCAL: { id: "951", name: "Homebase + SOCAL" } } }]);
}

test("saved and read on the master record; checked against the client's MLS list; nothing saved when refused", { skip }, async () => {
  seed();
  assert.deepEqual(await coverageDb!.getMlsAreas("os-homebase"), {});
  assert.deepEqual(await coverageDb!.setMlsAreas("os-homebase", { mlspin: "Greater Boston", SOCAL: "San Diego County" }), { "MLS PIN": "Greater Boston", SOCAL: "San Diego County" });
  assert.deepEqual(db.rows("os_clients").find((r) => r.id === "os-homebase")?.mls_areas, { "MLS PIN": "Greater Boston", SOCAL: "San Diego County" });
  await assert.rejects(coverageDb!.setMlsAreas("os-homebase", { BRIGHT: "Virginia" }), /isn't one of this client's MLSs/);
  assert.deepEqual(db.rows("os_clients").find((r) => r.id === "os-homebase")?.mls_areas, { "MLS PIN": "Greater Boston", SOCAL: "San Diego County" }, "refused: unchanged");
});

test("before migration 0056: read as not there (null), a save says which migration — and nothing else breaks", { skip }, async () => {
  seed();
  db.failWhen = ({ table, query }) => (table === "os_clients" && /mls_areas/.test(query.get("select") ?? "") ? { code: "42703", message: "column os_clients.mls_areas does not exist", status: 400 } : false);
  assert.equal(await coverageDb!.getMlsAreas("os-homebase"), null);
  assert.equal((await coverageDb!.listMlsAreas()).size, 0);
  await assert.rejects(coverageDb!.setMlsAreas("os-homebase", { SOCAL: "San Diego County" }), /needs migrations\/0056_mls_areas\.sql/);
  assert.deepEqual((await coverageDb!.getCoverage("os-homebase")).mls, ["MLS PIN", "SOCAL"], "Markets / MLS / Area read as before");
  // A campaign's area: exactly as before (every area) while the column isn't there.
  const cov = await coverageDb!.getCoverage("os-homebase");
  assert.equal(await mlsAreaDb!.areaForCampaign("os-homebase", 950, cov, "Greater Boston and San Diego County"), "Greater Boston and San Diego County");
  db.failWhen = null;
});

test("a campaign's area: its MLS (made at setup, or the team's pick for that MLS) → that MLS's area; none set → none; one MLS or no MLS → as before", { skip }, async () => {
  seed({ "MLS PIN": "Greater Boston" });
  const cov = await coverageDb!.getCoverage("os-homebase");
  const all = "Greater Boston and San Diego County";
  assert.equal(await mlsAreaDb!.campaignMlsCode("os-homebase", 950), "MLSPIN", "made at setup for MLSPIN");
  assert.equal(await mlsAreaDb!.campaignMlsCode("os-homebase", "951"), "SOCAL", "the team's SOCAL pick");
  assert.equal(await mlsAreaDb!.campaignMlsCode("os-homebase", 999), null);
  assert.equal(await mlsAreaDb!.areaForCampaign("os-homebase", 950, cov, all), "Greater Boston", "the setup code MLSPIN matches the record's 'MLS PIN'");
  assert.equal(await mlsAreaDb!.areaForCampaign("os-homebase", 951, cov, all), null, "SOCAL has no area set: none — never every area run together");
  assert.equal(await mlsAreaDb!.areaForCampaign("os-homebase", 999, cov, all), all, "a campaign that is no one MLS's: as before");
  const one = await coverageDb!.getCoverage("os-one");
  assert.equal(await mlsAreaDb!.areaForCampaign("os-one", 950, one, "Greater Denver"), "Greater Denver", "one MLS: as before, nothing looked up");
});
