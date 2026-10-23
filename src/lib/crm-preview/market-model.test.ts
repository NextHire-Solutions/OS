import { test } from "node:test";
import assert from "node:assert/strict";

import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";
import {
  bandOf, bandRows, clientForPortal, DEAL_BANDS, interestedReport, LIST_PILL, listFor, listSets, marketFilters,
  ownListEmail, parseMarketQuery, resolveMls, SALES_BANDS, type OsClientRow,
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

test("the query string: ranges, several brokerages and places, a known sort — held to sane values (21 Oct, Eddy's filters)", () => {
  const q = parseMarketQuery(new URLSearchParams("list=prospects&page=3&q=  smith &minVolume=2000000&maxVolume=8000000&minUnits=4&maxUnits=30&minYears=2&brokerage=Keller Williams&brokerage=Compass&brokerage=Compass&city=Atlanta&county=Cobb, GA&title=Team Leader&sort=name"));
  assert.deepEqual(q, {
    list: "prospects", page: 3, per: 50, q: "smith",
    volume: { min: 2_000_000, max: 8_000_000 }, units: { min: 4, max: 30 }, years: { min: 2, max: null },
    brokerages: ["Keller Williams", "Compass"], offices: [], cities: ["Atlanta"], counties: ["Cobb, GA"],
    titles: ["Team Leader"], not: { brokerages: [], offices: [], cities: [], counties: [], titles: [] }, sort: "name", dir: "asc",
  });
  // The old single values (the Setup wizard still sends them) read the same way.
  const old = parseMarketQuery(new URLSearchParams("minVolume=1000000&brokerage=Compass&county=Fulton"));
  assert.deepEqual([old.volume, old.brokerages, old.counties], [{ min: 1_000_000, max: null }, ["Compass"], ["Fulton"]]);
  const bad = parseMarketQuery(new URLSearchParams("list=drop&page=-1&minVolume=-7&maxUnits=1e9&minYears=abc&title=CEO&sort=password&dir=sideways&q=" + "x".repeat(200) + "&" + Array.from({ length: 30 }, (_, i) => `city=c${i}`).join("&")));
  assert.equal(bad.list, "market");
  assert.equal(bad.page, 1);
  assert.deepEqual([bad.volume.min, bad.units.max, bad.years.min], [null, null, null], "negative, absurd and non-numbers are dropped");
  assert.deepEqual(bad.titles, [], "only the three titles");
  assert.equal(bad.q.length, 80);
  assert.deepEqual([bad.sort, bad.dir], ["volume", "desc"], "an unknown sort is the default, largest first");
  assert.equal(bad.cities.length, 20, "at most 20 picks");
  assert.equal(parseMarketQuery(new URLSearchParams("sort=volume")).dir, "desc");
  assert.equal(parseMarketQuery(new URLSearchParams("sort=brokerage")).dir, "asc", "names A→Z on the first click");
  assert.equal(parseMarketQuery(new URLSearchParams("sort=name&dir=desc")).dir, "desc");
  assert.equal(parseMarketQuery(new URLSearchParams("page=99999")).page, 20, "a search goes 1,000 agents deep at most");
  assert.equal(parseMarketQuery(new URLSearchParams("per=8")).per, 8, "the Setup wizard's eight a page");
  assert.equal(parseMarketQuery(new URLSearchParams("per=8&page=99999")).page, 125, "the same depth, eight at a time");
  assert.equal(parseMarketQuery(new URLSearchParams("per=5000")).per, 50, "no other page size");
});

test("include and exclude (23 Oct, the Database app's): x-prefixed picks are left out — each kind its own list, titles only the three", () => {
  const q = parseMarketQuery(new URLSearchParams("title=Salesperson&xtitle=Team Leader&xtitle=CEO&xbrokerage=Compass&xoffice=KW Midtown&xcity=Decatur&xcounty=Cobb&office=Compass Buckhead"));
  assert.deepEqual(q.titles, ["Salesperson"]);
  assert.deepEqual(q.offices, ["Compass Buckhead"]);
  assert.deepEqual(q.not, { brokerages: ["Compass"], offices: ["KW Midtown"], cities: ["Decatur"], counties: ["Cobb"], titles: ["Team Leader"] });
  assert.equal(parseMarketQuery(new URLSearchParams(Array.from({ length: 30 }, (_, i) => `xcity=c${i}`).join("&"))).not.cities.length, 20, "at most 20 left out, too");
  const base = { mls: { include: ["m1"], exclude: [] } };
  assert.deepEqual(marketFilters(base, q), {
    mls: { include: ["m1"], exclude: [] },
    officeSearch: { brand: { include: [], exclude: ["Compass"] }, office: { include: ["Compass Buckhead"], exclude: ["KW Midtown"] } },
    // Only excluded places: no values, so nobody is required to be anywhere — just not in these.
    location: { field: "city", appliesTo: ["office", "home", "transacted"], values: [], excludeValues: [{ f: "city", v: "Decatur" }, { f: "county", v: "Cobb" }], excludeField: "city" },
    title: { include: ["Salesperson"], exclude: ["Team Leader"] },
  });
  // Excluded counties alone: the location's level is the county's.
  const counties = marketFilters(base, parseMarketQuery(new URLSearchParams("xcounty=Cobb"))) as { location: { field: string; excludeField: string } };
  assert.deepEqual([counties.location.field, counties.location.excludeField], ["county", "county"]);
  // An excluded title alone.
  assert.deepEqual((marketFilters(base, parseMarketQuery(new URLSearchParams("xtitle=Managing Broker"))) as { title: unknown }).title, { include: [], exclude: ["Managing Broker"] });
});

test("the filters as the Database app's, on top of the market or the client's lists", () => {
  const base = { mls: { include: ["m1"], exclude: [] } };
  const none = marketFilters(base, parseMarketQuery(new URLSearchParams("")));
  assert.deepEqual(none, base);
  const f = marketFilters(base, parseMarketQuery(new URLSearchParams("minVolume=2000000&maxVolume=8000000&maxUnits=30&minYears=2&brokerage=Compass&brokerage=eXp Realty&city=Atlanta&county=Cobb, GA&title=Salesperson&q=smith")));
  assert.deepEqual(f, {
    mls: { include: ["m1"], exclude: [] },
    salesVolume: { side: "all", buckets: [], min: "2000000", max: "8000000" },
    closedUnits: { side: "all", buckets: [], min: "", max: "30" },
    // Years, as the Database app sends them — the SQL makes months (21 Oct: "2+" had filtered 24+ years; the Atlanta market 1,455 instead of 91,804).
    estTimeInIndustry: { buckets: [], min: "2", max: "" },
    officeSearch: { brand: { include: ["Compass", "eXp Realty"], exclude: [] }, office: { include: [], exclude: [] } },
    // Cities and counties together, each keeping its level — any of them matches.
    location: { field: "city", appliesTo: ["office", "home", "transacted"], values: [{ f: "city", v: "Atlanta" }, { f: "county", v: "Cobb, GA" }], excludeValues: [], excludeField: "city" },
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

test("an agent's email reaches the page only when the client already has that exact address (22 Oct audit)", () => {
  const sets = listSets(
    [{ name: "Michael Johnson", email: null }, { name: "Pat Lee", email: "Pat.Lee@Old.test" }],
    [{ kind: "company", name: "Keller Williams", email: null, domain: "kw.com" }, { kind: "agent", name: "Dana Roe", email: "dana@x.test", domain: null }],
    [{ lead_name: "Jo Park", lead_email: "jo@park.test" }],
    new Set(),
  );
  // A company domain labels the row DNC — but sends no address.
  assert.equal(listFor({ id: "1", full_name: "Anyone At KW", emails: ["anyone@kw.com"] }, sets), "DNC List");
  assert.equal(ownListEmail(["anyone@kw.com"], sets), null);
  // A name-only My Agents entry matches every agent of that name — none of their addresses is sent.
  assert.equal(listFor({ id: "2", full_name: "Michael Johnson", emails: ["mj@elsewhere.test"] }, sets), "My Agents");
  assert.equal(ownListEmail(["mj@elsewhere.test"], sets), null);
  // An exact match sends the address the client holds — not the agent database's other one.
  assert.equal(ownListEmail(["preferred@new.test", "pat.lee@old.test"], sets), "pat.lee@old.test");
  assert.equal(ownListEmail([" Dana@X.test "], sets), "dana@x.test");
  assert.equal(ownListEmail(["jo@park.test"], sets), "jo@park.test");
  assert.equal(ownListEmail([], sets), null);
});
