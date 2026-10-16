import { test } from "node:test";
import assert from "node:assert/strict";

import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";
import {
  bandOf, bandRows, clientForPortal, DEAL_BANDS, interestedReport, LIST_PILL, listFor, listSets, marketFilters,
  parseMarketQuery, resolveMls, SALES_BANDS, type OsClientRow,
} from "./market-model.ts";

const client = (over: Partial<OsClientRow>): OsClientRow => ({ id: "c", name: "X", aliases: [], mi_client_id: null, mls_codes: [], orch_client_id: null, ...over });

test("a portal's client: the linked one, else the one named like the portal (a second market's portal)", () => {
  const pe = client({ id: "pe", name: "Properties & Estates", aliases: ["Properties & Estates Orlando"], mi_client_id: "p1" });
  const c21 = client({ id: "c21", name: "C21 Results Elite Team", mi_client_id: "p9" });
  assert.equal(clientForPortal({ id: "p1", name: "Properties & Estates Boston" }, [pe, c21])?.id, "pe");
  assert.equal(clientForPortal({ id: "p2", name: "Properties & Estates Orlando" }, [pe, c21])?.id, "pe");
  assert.equal(clientForPortal({ id: "p3", name: "Nobody" }, [pe, c21]), null);
  const twin = client({ id: "t", name: "Properties & Estates Orlando" });
  assert.equal(clientForPortal({ id: "p2", name: "Properties & Estates Orlando" }, [pe, twin]), null, "two claim the name: no guess");
});

const MLS = [
  { id: "m1", code: "GAMLS", name: "Georgia MLS", aliases: [] },
  { id: "m2", code: "FMLS", name: "First MLS", aliases: [] },
  { id: "m3", code: "ECAOR", name: "Emerald Coast", aliases: [] },
  { id: "m4", code: "SEFMIAMI", name: "Southeast Florida", aliases: ["SEF MLS"] },
];

test("MLS codes: exact code or alias only; anything else is named, never guessed", () => {
  assert.deepEqual(resolveMls(["FMLS", "GAMLS"], MLS).ids, ["m2", "m1"]);
  assert.deepEqual(resolveMls(["gamls", "G.A.M.L.S."], MLS).ids, ["m1"], "case and punctuation aside, counted once");
  const r = resolveMls(["ECOAR", "SEF-MLS", "CHMLS"], MLS);
  assert.deepEqual(r.ids, ["m4"], "an alias matches");
  assert.deepEqual(r.unmatched, ["ECOAR", "CHMLS"], "ECOAR is not read as ECAOR");
  assert.deepEqual(resolveMls(null, MLS), { ids: [], matched: [], unmatched: [] });
});

test("the query string is held to the chips' presets", () => {
  const q = parseMarketQuery(new URLSearchParams("list=prospects&page=3&q=  smith &minVolume=2000000&minUnits=4&minYears=2&brokerage=Keller Williams&county=Cobb, GA&title=Team Leader"));
  assert.deepEqual(q, { list: "prospects", page: 3, per: 50, q: "smith", minVolume: 2_000_000, minUnits: 4, minYears: 2, brokerage: "Keller Williams", county: "Cobb, GA", title: "Team Leader" });
  const bad = parseMarketQuery(new URLSearchParams("list=drop&page=-1&minVolume=7&minUnits=1e9&title=CEO&q=" + "x".repeat(200)));
  assert.equal(bad.list, "market");
  assert.equal(bad.page, 1);
  assert.equal(bad.minVolume, null);
  assert.equal(bad.minUnits, null);
  assert.equal(bad.title, null);
  assert.equal(bad.q.length, 80);
  assert.equal(parseMarketQuery(new URLSearchParams("page=99999")).page, 200, "deep pages are capped");
  assert.equal(parseMarketQuery(new URLSearchParams("per=8")).per, 8, "the Setup wizard's eight a page");
  assert.equal(parseMarketQuery(new URLSearchParams("per=8&page=99999")).page, 1250, "the same depth, eight at a time");
  assert.equal(parseMarketQuery(new URLSearchParams("per=5000")).per, 50, "no other page size");
});

test("the chips as the Database app's filters, on top of the market or the client's lists", () => {
  const base = { mls: { include: ["m1"], exclude: [] } };
  const none = marketFilters(base, parseMarketQuery(new URLSearchParams("")));
  assert.deepEqual(none, base);
  const f = marketFilters(base, parseMarketQuery(new URLSearchParams("minVolume=2000000&minUnits=4&minYears=2&brokerage=Compass&county=Cobb, GA&title=Salesperson&q=smith")));
  assert.deepEqual(f, {
    mls: { include: ["m1"], exclude: [] },
    salesVolume: { side: "all", buckets: [], min: "2000000", max: "" },
    closedUnits: { side: "all", buckets: [], min: "4", max: "" },
    estTimeInIndustry: { buckets: [], min: "24", max: "" },
    officeSearch: { brand: { include: ["Compass"], exclude: [] }, office: { include: [], exclude: [] } },
    location: { field: "county", appliesTo: ["office", "home", "transacted"], values: ["Cobb, GA"], excludeValues: [], excludeField: "county" },
    title: { include: ["Salesperson"], exclude: [] },
    nameQuery: "smith",
  });
});

test("bands: the design's labels, edges in the right band, nothing in two", () => {
  assert.deepEqual(SALES_BANDS.map((b) => b.label), ["Under $1M", "$1M to $2.5M", "$2.5M to $5M", "$5M to $10M", "$10M to $25M", "$25M+"]);
  assert.deepEqual(DEAL_BANDS.map((b) => b.label), ["0 to 2", "3 to 5", "6 to 10", "11 to 20", "21 or more"]);
  assert.equal(bandOf(0, SALES_BANDS), "Under $1M");
  assert.equal(bandOf(999_999, SALES_BANDS), "Under $1M");
  assert.equal(bandOf(1_000_000, SALES_BANDS), "$1M to $2.5M");
  assert.equal(bandOf(2_500_000, SALES_BANDS), "$2.5M to $5M");
  assert.equal(bandOf(25_000_000, SALES_BANDS), "$25M+");
  assert.equal(bandOf(null, SALES_BANDS), "Unknown");
  assert.equal(bandOf(2, DEAL_BANDS), "0 to 2");
  assert.equal(bandOf(3, DEAL_BANDS), "3 to 5");
  assert.equal(bandOf(21, DEAL_BANDS), "21 or more");
  // Every whole dollar from 0 to $30M lands in exactly one band.
  for (const n of [0, 1, 999_999.99, 1_000_000, 2_499_999.99, 2_500_000, 4_999_999.99, 5_000_000, 9_999_999.99, 10_000_000, 24_999_999.99, 25_000_000, 30_000_000]) {
    assert.equal(SALES_BANDS.filter((b) => (b.min === null || n >= b.min) && (b.max === null || n <= b.max)).length, 1, String(n));
  }
  assert.deepEqual(bandRows(new Map([["3 to 5", 4], ["Unknown", 2]]), DEAL_BANDS).map((r) => `${r.label}:${r.n}`), ["0 to 2:0", "3 to 5:4", "6 to 10:0", "11 to 20:0", "21 or more:0", "Unknown:2"]);
  assert.equal(bandRows(new Map(), DEAL_BANDS).some((r) => r.label === "Unknown"), false, "no Unknown row when there is none");
});

const lead = (cf: Record<string, unknown>, over: Partial<PipelineEntry> = {}) =>
  ({ lead_detail: { custom_fields: cf }, lead_location: null, current_brokerage: null, ...over }) as Pick<PipelineEntry, "lead_detail" | "lead_location" | "current_brokerage">;

test("Interested only: the client's pipeline by brokerage, office city, sales volume and deals", () => {
  const r = interestedReport([
    lead({ "Sales Volume": "$2,314,500", "Closed transactions": "8", "Office city": "Marietta, GA" }, { current_brokerage: "Keller Williams" }),
    lead({ "Sales Volume": "900000", "Closed Transactions": 2 }, { current_brokerage: "keller williams", lead_location: "atlanta, GA" }),
    lead({}, { current_brokerage: "Compass" }),
    lead({ "sales volume": "30000000", closedTransactions: "25" }),
  ]);
  assert.equal(r.total, 4);
  const [brokerage, city, sales, deals] = r.groups;
  assert.deepEqual(brokerage.rows, [{ label: "Keller Williams", n: 2 }, { label: "Compass", n: 1 }, { label: "Unknown", n: 1 }], "same brokerage whatever its case");
  assert.deepEqual(brokerage.of, { shown: 2, total: 2, noun: "brokerages" });
  assert.deepEqual(city.rows, [{ label: "Atlanta", n: 1 }, { label: "Marietta", n: 1 }, { label: "Unknown", n: 2 }]);
  assert.deepEqual(sales.rows.filter((x) => x.n).map((x) => `${x.label}:${x.n}`), ["Under $1M:1", "$1M to $2.5M:1", "$25M+:1", "Unknown:1"]);
  assert.deepEqual(deals.rows.filter((x) => x.n).map((x) => `${x.label}:${x.n}`), ["0 to 2:1", "6 to 10:1", "21 or more:1", "Unknown:1"]);
});

test("the List column: DNC over My Agents over the pipeline over Prospects; email first, a name only where the entry has no email", () => {
  const sets = listSets(
    [{ name: "Sierra Shaw", email: null }, { name: "Lo", email: null }, { name: "Mia Park", email: "MIA@kw.com" }],
    [
      { kind: "agent", name: "Stacey Wylie", email: null, domain: null },
      { kind: "agent", name: "Dan Ford", email: "dan@x.com", domain: null },
      { kind: "company", name: "Sister Office", email: null, domain: "@sister.com" },
    ],
    [{ lead_name: "Carlina Jones", lead_email: "carlina@hester.com" }, { lead_name: "Kelly Jones", lead_email: null }],
    new Set(["a1", "a2", "p1"]),
  );
  assert.equal(listFor({ id: "p1", full_name: "Carlina Jones", emails: ["Carlina@Hester.com"] }, sets), "In your pipeline", "the pipeline wins over Prospects");
  assert.equal(listFor({ id: "p2", full_name: "Kelly Jones", emails: [] }, sets), "In your pipeline");
  assert.equal(listFor({ id: "p3", full_name: "Carlina Jones", emails: [] }, sets), "Not on a list", "a pipeline lead with an email matches on the email only");
  assert.deepEqual(Object.keys(LIST_PILL), ["DNC List", "My Agents", "In your pipeline", "Prospects", "Not on a list"]);
  const a = (id: string, full_name: string, emails: string[] = []) => ({ id, full_name, emails });
  assert.equal(listFor(a("a1", "Sierra Shaw"), sets), "My Agents", "My Agents wins over Prospects");
  assert.equal(listFor(a("a2", "Stacey Wylie"), sets), "DNC List");
  assert.equal(listFor(a("a3", "Anyone", ["x@sister.com"]), sets), "DNC List", "a blocked company's domain");
  assert.equal(listFor(a("a4", "Dan Ford"), sets), "Not on a list", "an entry with an email matches on the email, not the name");
  assert.equal(listFor(a("a5", "Someone", ["dan@x.com"]), sets), "DNC List");
  assert.equal(listFor(a("a6", "Mia Park", ["mia@kw.com"]), sets), "My Agents");
  assert.equal(listFor(a("a7", "Lo"), sets), "Not on a list", "a name too short to trust never matches");
  assert.equal(listFor(a("a2x", "Nobody"), sets), "Not on a list");
  assert.equal(listFor({ id: "a2", full_name: "Other Name", emails: [] }, { ...sets, dncNames: new Set() }), "Prospects");
});
