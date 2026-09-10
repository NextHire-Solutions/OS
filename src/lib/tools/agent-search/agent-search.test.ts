import assert from "node:assert/strict";
import { test } from "node:test";

import { ALL_COLUMNS, COURTED_COLUMNS, IMPORT_COLUMNS, KEY_COLUMNS, REALTOR_COLUMNS, SOURCES, ZILLOW_COLUMNS } from "./columns.ts";
import { countLabel, cellKind, importNote, mlsDisplayName, splitLocations, toCsv } from "./format.ts";
import { licenseKey, normEmail, normLicense, normPhone, validEmail, validPhone10 } from "./identity.ts";
import { buildMaster } from "./merge.ts";
import { detectSource, enrichCost, extractUrls, normalizeUrl, parseCsvGrid, parseDataset, summarize, toCsvExportUrl } from "./sheet-source.ts";
import { diffAccount, indexScan, type ScannedAccount } from "./baseline.ts";
import {
  buildEnrichPayload, buildSearchPayload, buildSweepPayload,
  type EnrichPayload, type SearchForm, type SearchPayload,
} from "./payload.ts";

/*
 * These lock the ported logic to the tool's behaviour.
 *
 * They were written alongside a differential harness that imports the TOOL's
 * own merge.js / sheet-source.js / profile-parser.js and asserts identical
 * output on the same inputs — 48/48 identical. That harness cannot live in
 * this repo because it needs the scraper checkout on disk, so these tests
 * pin the same behaviours self-containedly.
 */

/* ========================================================================= */
/* columns                                                                    */
/* ========================================================================= */

test("column lists match the tool's exports exactly", () => {
  // Counts taken from importing the tool's own modules.
  assert.equal(COURTED_COLUMNS.length, 77);
  assert.equal(ZILLOW_COLUMNS.length, 45);
  assert.equal(REALTOR_COLUMNS.length, 45);

  // Order is the CSV layout and the master-list union order, so the ends are
  // pinned, not just the length.
  assert.equal(COURTED_COLUMNS[0], "Name");
  assert.equal(COURTED_COLUMNS.at(-1), "Searched Location");
  assert.equal(ZILLOW_COLUMNS[0], "Name");
  assert.equal(ZILLOW_COLUMNS.at(-1), "All Licenses");
  assert.equal(REALTOR_COLUMNS.at(-1), "Searched Location");

  // The primary keys db.js dedupes on must be present under these exact names.
  assert.ok(COURTED_COLUMNS.includes("Courted ID"));
  assert.ok(ZILLOW_COLUMNS.includes("Zillow Profile URL"));
  assert.ok(REALTOR_COLUMNS.includes("Realtor Profile URL"));

  // No duplicates — buildColumns dedupes by name, so a repeat would silently
  // drop a column from every master export.
  for (const [name, cols] of Object.entries(ALL_COLUMNS)) {
    assert.equal(new Set(cols).size, cols.length, `${name} has a duplicate column`);
  }
});

test("key columns are a strict subset of the full lists", () => {
  // The "Show all columns" toggle swaps between them, so a key column that is
  // not a real column renders a permanently empty table column.
  for (const s of SOURCES) {
    for (const c of KEY_COLUMNS[s]) {
      assert.ok(ALL_COLUMNS[s].includes(c), `${s}: "${c}" is not a real column`);
    }
  }
});

test("import columns are the tool's fixed eight", () => {
  assert.deepEqual([...IMPORT_COLUMNS],
    ["Status", "Source", "Name", "Phone", "Email", "License", "Profile URL", "Note"]);
});

/* ========================================================================= */
/* merge — the master list                                                    */
/* ========================================================================= */

const COLS = { courted: COURTED_COLUMNS, zillow: ZILLOW_COLUMNS, realtor: REALTOR_COLUMNS };

test("merges the same agent across sources on a shared phone", () => {
  const { rows, stats } = buildMaster({
    courted: [{ Name: "Jane Doe", Phone: "(305) 555-0101", Office: "Acme", "Office City": "Miami" }],
    zillow: [{ Name: "Jane Doe", Phone: "305-555-0101", Brokerage: "Acme", City: "Miami" }],
  }, COLS);

  assert.equal(stats.unique, 1);
  assert.equal(stats.duplicatesRemoved, 1);
  assert.equal(stats.multiPlatform, 1);
  assert.equal(rows[0]["Sources"], "Courted, Zillow");
  assert.equal(rows[0]["Platform Count"], "2");
  assert.match(String(rows[0]["Match Basis"]), /phone/);
});

test("merges on email case-insensitively, and on license + last name", () => {
  const byEmail = buildMaster({
    courted: [{ Name: "Bob Smith", Email: "BOB@X.COM" }],
    realtor: [{ Name: "Robert Smith", Email: "bob@x.com" }],
  }, COLS);
  assert.equal(byEmail.stats.unique, 1);
  assert.match(String(byEmail.rows[0]["Match Basis"]), /email/);

  // Formatting differences in the licence must not defeat the match.
  const byLicense = buildMaster({
    courted: [{ Name: "Jane Doe", "Last Name": "Doe", "State License": "SL-3212345" }],
    realtor: [{ Name: "Jane Doe", "Last Name": "Doe", "License Number": "sl3212345" }],
  }, COLS);
  assert.equal(byLicense.stats.unique, 1);
  assert.match(String(byLicense.rows[0]["Match Basis"]), /license/);
});

test("a licence alone never merges two different people", () => {
  // licenseKey requires a last name precisely to stop this.
  const r = buildMaster({
    courted: [{ Name: "Jane Doe", "Last Name": "Doe", "State License": "12345678" }],
    realtor: [{ Name: "Alan Poe", "Last Name": "Poe", "License Number": "12345678" }],
  }, COLS);
  assert.equal(r.stats.unique, 2);
});

test("name+city needs two name tokens, so single names never collide", () => {
  const single = buildMaster({
    courted: [{ Name: "Cher", "Office City": "Miami" }],
    zillow: [{ Name: "Cher", City: "Miami" }],
  }, COLS);
  assert.equal(single.stats.unique, 2, "single-token names must not merge");

  const full = buildMaster({
    courted: [{ Name: "Dana Lee", "Office City": "Austin" }],
    zillow: [{ Name: "Dana Lee", City: "Austin" }],
  }, COLS);
  assert.equal(full.stats.unique, 1);
  assert.match(String(full.rows[0]["Match Basis"]), /name\+city/);
});

test("the same name in different cities stays two agents", () => {
  const r = buildMaster({
    courted: [{ Name: "Dana Lee", "Office City": "Austin" }],
    zillow: [{ Name: "Dana Lee", City: "Miami" }],
  }, COLS);
  assert.equal(r.stats.unique, 2);
});

test("suffix and designation noise is stripped before comparing names", () => {
  // "Jane Doe, REALTOR" and "Jane Doe PA" are one person.
  const r = buildMaster({
    courted: [{ Name: "Jane Doe, REALTOR", "Office City": "Miami" }],
    zillow: [{ Name: "Jane Doe PA", City: "Miami" }],
  }, COLS);
  assert.equal(r.stats.unique, 1);
});

test("a phone shorter than ten digits is not a key", () => {
  const r = buildMaster({
    courted: [{ Name: "A One", Phone: "5550101", "Office City": "X" }],
    zillow: [{ Name: "B Two", Phone: "5550101", City: "Y" }],
  }, COLS);
  assert.equal(r.stats.unique, 2);
});

test("Courted beats Realtor beats Zillow when the same column is filled", () => {
  const r = buildMaster({
    courted: [{ Name: "Jane Doe", Email: "j@a.com", Phone: "3055550101", Title: "Broker" }],
    realtor: [{ Name: "Jane Doe", Email: "j@a.com", Phone: "3055550101", Title: "Agent" }],
    zillow: [{ Name: "Jane Doe", Email: "j@a.com", Phone: "3055550101", Title: "Assistant" }],
  }, COLS);
  assert.equal(r.stats.unique, 1);
  assert.equal(r.rows[0]["Title"], "Broker");
  assert.equal(r.rows[0]["Sources"], "Courted, Realtor, Zillow");
  assert.equal(r.rows[0]["Platform Count"], "3");
});

test("an empty value never overwrites a filled one", () => {
  const r = buildMaster({
    courted: [{ Name: "Jane Doe", Email: "j@a.com", Office: "" }],
    zillow: [{ Name: "Jane Doe", Email: "j@a.com", Office: "Acme" }],
  }, COLS);
  assert.equal(r.rows[0]["Office"], "Acme");
});

test("transitive merging: A~B by phone and B~C by email yields one agent", () => {
  // Union-Find, not pairwise — the reason the tool uses it at all.
  const r = buildMaster({
    courted: [{ Name: "Jane Doe", Phone: "3055550101" }],
    zillow: [{ Name: "Jane Doe", Phone: "3055550101", Email: "j@a.com" }],
    realtor: [{ Name: "J Doe", Email: "j@a.com" }],
  }, COLS);
  assert.equal(r.stats.unique, 1);
  assert.equal(r.rows[0]["Platform Count"], "3");
});

test("master columns lead with Name and the three meta columns, then union", () => {
  const { columns } = buildMaster({ courted: [{ Name: "x" }] }, COLS);
  assert.deepEqual(columns.slice(0, 4), ["Name", "Sources", "Platform Count", "Match Basis"]);
  assert.equal(new Set(columns).size, columns.length, "no duplicate columns");
  // Every source column survives the union.
  for (const s of SOURCES) for (const c of ALL_COLUMNS[s]) assert.ok(columns.includes(c), `lost ${c}`);
});

test("multi-platform rows sort first, then by name", () => {
  const r = buildMaster({
    courted: [{ Name: "Zach Solo" }, { Name: "Amy Both", Email: "a@b.com" }],
    zillow: [{ Name: "Amy Both", Email: "a@b.com" }],
  }, COLS);
  assert.equal(r.rows[0]["Name"], "Amy Both");
  assert.equal(r.rows[0]["Platform Count"], "2");
});

test("Match Basis is empty for an unmerged row", () => {
  const r = buildMaster({ courted: [{ Name: "Solo Person" }] }, COLS);
  assert.equal(r.rows[0]["Match Basis"], "");
  assert.equal(r.rows[0]["Platform Count"], "1");
});

test("two rows from the SAME source that match are still deduped", () => {
  const r = buildMaster({
    courted: [{ Name: "Jane Doe", Email: "j@a.com" }, { Name: "Jane Doe", Email: "j@a.com" }],
  }, COLS);
  assert.equal(r.stats.unique, 1);
  // ...but the basis is "merged", not "email": nothing crossed a source.
  assert.equal(r.rows[0]["Match Basis"], "merged");
  assert.equal(r.rows[0]["Platform Count"], "1");
});

test("no input produces no rows and honest zeroes", () => {
  const r = buildMaster({}, COLS);
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.stats.bySource, { courted: 0, zillow: 0, realtor: 0 });
  assert.equal(r.stats.totalScraped, 0);
  assert.equal(r.stats.duplicatesRemoved, 0);
});

/* ========================================================================= */
/* sheet-source — the import parser                                           */
/* ========================================================================= */

test("a Google Sheet link becomes its no-auth CSV export URL", () => {
  assert.equal(
    toCsvExportUrl("https://docs.google.com/spreadsheets/d/1AbC-dEf_gh/edit#gid=1234567"),
    "https://docs.google.com/spreadsheets/d/1AbC-dEf_gh/export?format=csv&gid=1234567");
  // No gid means the first tab.
  assert.equal(
    toCsvExportUrl("https://docs.google.com/spreadsheets/d/XYZ/edit"),
    "https://docs.google.com/spreadsheets/d/XYZ/export?format=csv&gid=0");
  assert.equal(toCsvExportUrl("https://example.com/nope"), null);
  assert.equal(toCsvExportUrl(""), null);
});

test("the CSV parser handles quotes, escaped quotes and CRLF", () => {
  const grid = parseCsvGrid('a,"b,c","d""e"\r\n1,2,3\r\n');
  assert.deepEqual(grid, [["a", "b,c", 'd"e'], ["1", "2", "3"]]);
});

test("a real header keeps each row's identifiers", () => {
  const rows = parseDataset(
    "Full Name,Email Address,Mobile Phone,Agent Profile,State,City,County,Current Brokerage\n" +
    '"Doe, Jane",jane@acme.com,(305) 555-0101,https://www.zillow.com/profile/janedoe/?src=x,FL,Miami,Dade,Acme\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "zillow");
  assert.equal(rows[0].name, "Doe, Jane");
  assert.equal(rows[0].email, "jane@acme.com");
  assert.equal(rows[0].phone, "(305) 555-0101");
  assert.equal(rows[0].state, "FL");
  assert.equal(rows[0].county, "Dade");
  assert.equal(rows[0].brokerage, "Acme");
});

test("rows with no profile URL are dropped, and identical URLs collapse", () => {
  const rows = parseDataset(
    "Full Name,Email Address,Agent Profile\n" +
    "A,a@x.com,https://www.zillow.com/profile/jane\n" +
    "B,b@x.com,https://www.zillow.com/profile/jane/\n" +  // trailing slash only
    "C,c@x.com,\n");                                       // nothing to enrich
  assert.equal(rows.length, 1);
});

test("de-duping is LITERAL, not canonical — the tool's behaviour, pinned", () => {
  /*
   * A gap in the tool, reproduced deliberately rather than fixed.
   *
   * parseDataset and extractUrls key on `url.toLowerCase()` with trailing
   * slashes stripped — so "www." and the scheme still distinguish two entries.
   * normalizeUrl() exists in profile-parser.js and collapses all of these to
   * one key, but neither function calls it; only reconcile.js does.
   *
   * Consequence: the same agent listed once with www and once without is
   * scraped twice and billed twice. Small, real, and NOT something a port
   * should silently repair — the preview count here must equal the count the
   * live service will run, and the live service does this.
   */
  const rows = parseDataset(
    "Full Name,Agent Profile\n" +
    "A,https://www.zillow.com/profile/jane\n" +
    "B,https://zillow.com/profile/jane\n");
  assert.equal(rows.length, 2, "www and non-www are two rows to the tool");

  // Whereas normalizeUrl — the canonical form — sees one agent.
  assert.equal(normalizeUrl(rows[0].url), normalizeUrl(rows[1].url));
});

test("a bare URL list is accepted when there is no header", () => {
  const rows = parseDataset(
    "https://www.zillow.com/profile/aaa\n" +
    "https://www.realtor.com/realestateagents/bbb\n" +
    "not-a-url\n");
  assert.deepEqual(rows.map((r) => r.source), ["zillow", "realtor"]);
  // Bare rows carry no identifiers, so nothing can be pre-matched.
  assert.equal(summarize(rows).withIdentity, 0);
});

test("a header row that itself holds a URL is treated as data", () => {
  // Otherwise the first agent in a headerless export is silently thrown away.
  const rows = parseDataset("zillow,url\nhttps://www.zillow.com/profile/x,y\n");
  assert.equal(rows.length, 1);
});

test("empty and whitespace-only input yields nothing rather than throwing", () => {
  assert.deepEqual(parseDataset(""), []);
  assert.deepEqual(parseDataset("\n\n\n"), []);
  assert.deepEqual(extractUrls(""), []);
});

test("extractUrls de-duplicates case- and trailing-slash-insensitively", () => {
  assert.equal(
    extractUrls("https://www.zillow.com/profile/Jane https://www.zillow.com/profile/jane/").length,
    1);
  // ...but see the LITERAL de-duping test above: www and scheme still split.
  assert.equal(
    extractUrls("https://www.zillow.com/profile/Jane https://zillow.com/profile/Jane").length,
    2);
});

test("summarize counts sources and identity coverage", () => {
  const rows = parseDataset(
    "Full Name,Email Address,Agent Profile\n" +
    "A,a@x.com,https://www.zillow.com/profile/a\n" +
    "B,,https://www.realtor.com/realestateagents/b\n");
  assert.deepEqual(summarize(rows), { zillow: 1, realtor: 1, total: 2, withIdentity: 1 });
});

test("detectSource only accepts the two real profile shapes", () => {
  assert.equal(detectSource("https://www.zillow.com/profile/x"), "zillow");
  assert.equal(detectSource("https://realtor.com/realestateagents/x"), "realtor");
  assert.equal(detectSource("https://realtor.com/realestateagentsX/x"), null);
  assert.equal(detectSource("https://www.trulia.com/profile/x"), null);
  assert.equal(detectSource(""), null);
});

test("normalizeUrl strips protocol, www, query and trailing slash", () => {
  assert.equal(normalizeUrl("https://www.zillow.com/profile/JaneDoe/?src=x"), "zillow.com/profile/janedoe");
  assert.equal(normalizeUrl("http://zillow.com/profile/x#frag"), "zillow.com/profile/x");
});

test("the cost estimate is Bright Data's rate to three decimals", () => {
  assert.equal(enrichCost(1000), 1.5);
  assert.equal(enrichCost(1), 0.002);   // 0.0015 -> 0.002 at 3dp
  assert.equal(enrichCost(0), 0);
});

/* ========================================================================= */
/* format                                                                     */
/* ========================================================================= */

test("CSV export leads with a BOM and escapes properly", () => {
  const csv = toCsv([{ Name: 'Smith, "Bo"', Note: "line1\nline2" }], ["Name", "Note", "Missing"]);
  assert.ok(csv.startsWith("﻿"), "must start with a UTF-8 BOM for Excel");
  const body = csv.slice(1);
  assert.equal(body.split("\n")[0], "Name,Note,Missing");
  assert.ok(body.includes('"Smith, ""Bo"""'));
  assert.ok(body.includes('"line1\nline2"'));
  assert.ok(body.endsWith(","), "a missing column becomes an empty field, not 'undefined'");
});

test("locations split on newlines and semicolons but never commas", () => {
  assert.deepEqual(splitLocations("Miami, FL\nBoca Raton, FL\n33139"),
    ["Miami, FL", "Boca Raton, FL", "33139"]);
  assert.deepEqual(splitLocations(" Miami, FL ; Tampa, FL "), ["Miami, FL", "Tampa, FL"]);
  assert.deepEqual(splitLocations("\n\n  \n"), []);
});

test("an unnamed CTD_ bucket is relabelled, a real MLS is not", () => {
  assert.equal(mlsDisplayName({ code: "CTD_9f2a", name: "" }), "Custom list (Courted)");
  assert.equal(mlsDisplayName({ code: "CTD_9f2a", name: "CTD_9f2a" }), "Custom list (Courted)");
  assert.equal(mlsDisplayName({ code: "CANOPY", name: "Canopy MLS" }), "Canopy MLS");
  assert.equal(mlsDisplayName({ code: "CANOPY", name: "" }), "CANOPY");
  // A NAMED custom list keeps its name.
  assert.equal(mlsDisplayName({ code: "CTD_1", name: "My list" }), "My list");
});

test("every import status explains itself", () => {
  assert.equal(importNote({ status: "skipped" }), "already in the database");
  assert.equal(importNote({ status: "dead" }), "no agent found on the page");
  assert.match(importNote({ status: "blocked" }), /CAPTCHA/);
  assert.equal(importNote({ status: "error", message: "boom" }), "boom");
  assert.equal(importNote({ status: "error" }), "scrape error");
  assert.equal(importNote({ status: "new" }), "");
});

test("cells render as link, money or text", () => {
  assert.deepEqual(cellKind("Zillow Profile URL", "https://z/1"), { kind: "link", href: "https://z/1" });
  assert.deepEqual(cellKind("LTM Sales Volume", "12500000"), { kind: "money", text: "$12,500,000" });
  // Already formatted, so not all digits — left alone rather than mangled.
  assert.deepEqual(cellKind("LTM Sales Volume", "$12,500,000"), { kind: "text", text: "$12,500,000" });
  assert.deepEqual(cellKind("Name", "Jane"), { kind: "text", text: "Jane" });
  assert.deepEqual(cellKind("Name", ""), { kind: "empty" });
});

test("the count badge shows fetched/total, and honours the server count", () => {
  assert.equal(countLabel(10, 0, 250), "10 / 250");
  assert.equal(countLabel(250, 0, 250), "250");
  assert.equal(countLabel(0, 0, null), "0");
  // A full sweep streams to the DB, not the table: 0 rendered, 9,000 fetched.
  assert.equal(countLabel(0, 9000, 12000), "9,000 / 12,000");
});

/* ========================================================================= */
/* identity — the cross-check guards                                          */
/* ========================================================================= */

test("phone and email normalise to their comparison form", () => {
  assert.equal(normPhone("+1 (305) 555-0101"), "3055550101");
  // Eleven digits once the extension is swept in, so the last ten are taken —
  // and the result then FAILS validPhone10 (leading 0), which is the guard
  // that stops it being used as an identifier. Both halves matter.
  assert.equal(normPhone("305-555-0101 ext 4"), "0555501014");
  assert.equal(validPhone10(normPhone("305-555-0101 ext 4")), false);
  assert.equal(normPhone("555-0101"), "");
  assert.equal(normEmail("  JANE@Acme.COM "), "jane@acme.com");
  assert.equal(normLicense(" sl-321 2345 "), "SL3212345");
});

test("placeholder phone numbers are refused as identifiers", () => {
  // The table holds 100+ rows of +10000000000. Matching one would DROP a real
  // new agent, because the write path only ever inserts.
  assert.equal(validPhone10("0000000000"), false);
  assert.equal(validPhone10("1111111111"), false);
  assert.equal(validPhone10("1055550101"), false, "NANP area codes never start with 1");
  assert.equal(validPhone10("3050550101"), false, "NANP exchanges never start with 0/1");
  assert.equal(validPhone10("305555010"), false, "nine digits");
  assert.equal(validPhone10("3055550101"), true);
});

test("junk licences are refused as identifiers", () => {
  assert.equal(licenseKey("0"), "");
  assert.equal(licenseKey("0000"), "");
  assert.equal(licenseKey("N/A"), "");
  assert.equal(licenseKey(""), "");
  assert.equal(licenseKey("abc"), "", "under four characters");
  assert.equal(licenseKey("SL-3212345"), "SL-3212345");
});

test("email validity is the cheap shape check, not a parser", () => {
  assert.equal(validEmail("jane@acme.com"), true);
  assert.equal(validEmail("jane@acme"), false);
  assert.equal(validEmail("jane acme.com"), false);
  assert.equal(validEmail(""), false);
});

/* ========================================================================= */
/* baseline — the MLS monitor's diff                                          */
/* ========================================================================= */

test("indexScan produces the tool's own localStorage shape", () => {
  const scanned: ScannedAccount[] = [
    { email: "a@b.com", total: 100, mls: [{ code: "CANOPY", name: "Canopy MLS", count: 60 }] },
  ];
  assert.deepEqual(indexScan(scanned), {
    "a@b.com": { total: 100, codes: { CANOPY: { name: "Canopy MLS", count: 60 } } },
  });
});

test("an account that failed to log in is NEVER baselined", () => {
  /*
   * The single most important line in this file. If a stale password meant an
   * empty MLS list got saved as the baseline, the next scan would report all
   * six of that account's boards as "removed" — a login problem masquerading
   * as losing MLS access, with a Slack alert to match.
   */
  const scanned: ScannedAccount[] = [
    { email: "ok@b.com", total: 10, mls: [{ code: "X", name: "X MLS", count: 10 }] },
    { email: "bad@b.com", error: "Courted login failed" },
  ];
  const idx = indexScan(scanned);
  assert.deepEqual(Object.keys(idx), ["ok@b.com"]);
});

test("diffAccount reports additions, removals and no-change", () => {
  const base = { A: { name: "A", count: 1 }, B: { name: "B", count: 2 } };

  const added = diffAccount(base, [{ code: "A" }, { code: "B" }, { code: "C" }]);
  assert.deepEqual(added.added, ["C"]);
  assert.deepEqual(added.removed, []);
  assert.equal(added.changed, true);

  const removed = diffAccount(base, [{ code: "A" }]);
  assert.deepEqual(removed.removed, ["B"]);
  assert.equal(removed.changed, true);

  const same = diffAccount(base, [{ code: "A" }, { code: "B" }]);
  assert.equal(same.changed, false);
  assert.equal(same.hadBaseline, true);
});

test("with no baseline nothing is a change", () => {
  // A first scan must not paint every MLS as newly added.
  const d = diffAccount(null, [{ code: "A" }, { code: "B" }]);
  assert.equal(d.hadBaseline, false);
  assert.equal(d.changed, false);
  assert.deepEqual(d.added, ["A", "B"]);   // computed, but `changed` gates its use
});

test("indexScan tolerates missing fields rather than throwing", () => {
  assert.deepEqual(indexScan(null), {});
  assert.deepEqual(indexScan([{ email: "x@y.com" }]), { "x@y.com": { total: 0, codes: {} } });
});

/* ========================================================================= */
/* payload — the requests that COST MONEY, asserted but never sent            */
/* ========================================================================= */

/*
 * Starting a search spends Bright Data proxy traffic, Realtor.com credits and
 * hours of a shared container; a whole-account Courted sweep re-scrapes up to
 * 866,000 agents. None of these tests make a request. They assert the exact
 * object that WOULD be posted, which is the only responsible way to verify a
 * control whose side effect is a bill.
 */

const FORM: SearchForm = {
  locations: "", sources: { courted: true, zillow: true, realtor: false },
  courtedMax: "0", minSalesVolume: "0", courtedEnrich: false, courtedAllAgents: false,
  zillowMaxPages: "25", zillowConcurrency: "4", zillowEnrich: false,
  realtorMax: "50", realtorConcurrency: "3", realtorEnrich: false,
};

test("a search with no location and no all-agents sweep is REFUSED", () => {
  const r = buildSearchPayload(FORM);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /at least one location/);
});

test("no source selected is REFUSED", () => {
  const r = buildSearchPayload({
    ...FORM, locations: "Miami, FL",
    sources: { courted: false, zillow: false, realtor: false },
  });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /at least one source/);
});

test("an all-agents Courted sweep needs no location — the one exception", () => {
  const r = buildSearchPayload({ ...FORM, courtedAllAgents: true });
  assert.equal(r.ok, true);
  assert.deepEqual((r as { payload: SearchPayload }).payload.locations, []);
});

test("the default search posts exactly the tool's body", () => {
  const r = buildSearchPayload({ ...FORM, locations: "Miami, FL\nBoca Raton, FL" });
  assert.equal(r.ok, true);
  assert.deepEqual((r as { payload: SearchPayload }).payload, {
    locations: ["Miami, FL", "Boca Raton, FL"],
    sources: ["courted", "zillow"],
    courtedMax: 0,
    minSalesVolume: 0,
    courtedEnrich: false,
    courtedAllAgents: false,
    zillowMaxPages: 25,
    zillowConcurrency: 4,
    zillowEnrich: false,
    realtorMax: 50,
    realtorConcurrency: 3,
    realtorEnrich: false,
  });
});

test("blank numeric boxes fall back to the tool's defaults, and 0 means all", () => {
  const r = buildSearchPayload({
    ...FORM, locations: "33139",
    courtedMax: "", minSalesVolume: "", zillowMaxPages: "", zillowConcurrency: "",
    realtorMax: "", realtorConcurrency: "",
  });
  const p = (r as { payload: SearchPayload }).payload;
  assert.equal(p.zillowMaxPages, 25, "blank -> Zillow's 25-page cap");
  assert.equal(p.zillowConcurrency, 4);
  assert.equal(p.realtorConcurrency, 3);
  // 0 is a REAL value here — "all matches" — not a missing one.
  assert.equal(p.courtedMax, 0);
  assert.equal(p.minSalesVolume, 0);
  assert.equal(p.realtorMax, 0);
});

test("sources are posted in the tool's fixed order, not click order", () => {
  const r = buildSearchPayload({
    ...FORM, locations: "Miami, FL",
    sources: { realtor: true, courted: true, zillow: true },
  });
  assert.deepEqual((r as { payload: SearchPayload }).payload.sources, ["courted", "zillow", "realtor"]);
});

test("a whole-account sweep omits courtedMlsIds entirely", () => {
  const body = buildSweepPayload("agent@brokerage.com", []);
  assert.deepEqual(body, {
    sources: ["courted"],
    courtedOnly: ["agent@brokerage.com"],
    courtedAllAgents: true,
    courtedBanded: true,
  });
  assert.equal("courtedMlsIds" in body, false, "absent, not an empty array");
});

test("a per-MLS sweep carries only the chosen codes", () => {
  const body = buildSweepPayload("agent@brokerage.com", ["CANOPY", "CHSMLS"]);
  assert.deepEqual(body.courtedMlsIds, ["CANOPY", "CHSMLS"]);
  // Still banded and still scoped to the one account — a sweep that lost
  // courtedOnly would re-scrape all nine logins.
  assert.deepEqual(body.courtedOnly, ["agent@brokerage.com"]);
  assert.equal(body.courtedBanded, true);
});

test("an enrichment with no input is REFUSED before it can cost anything", () => {
  const r = buildEnrichPayload("", "   ", "4");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /Google Sheet link or a CSV/);
});

test("an enrichment payload carries the sheet, the csv and the concurrency", () => {
  const r = buildEnrichPayload("  https://docs.google.com/spreadsheets/d/X/edit  ", "", "");
  assert.equal(r.ok, true);
  assert.deepEqual((r as { payload: EnrichPayload }).payload, {
    sheetUrl: "https://docs.google.com/spreadsheets/d/X/edit",
    csv: "",
    concurrency: 4,
  });
});
