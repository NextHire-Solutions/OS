import { test } from "node:test";
import assert from "node:assert/strict";

import { createClient } from "@supabase/supabase-js";

import { FakePostgrest } from "../tools/master-inbox/test/fake-postgrest.ts";

/*
 * Market's Move to on the Demo Portal (23 Oct — the client: "not built yet on
 * demo portal"). A fake database stands in for both the inbox's and the agent
 * database's: no request leaves the process.
 */

process.env.AGENT_SEARCH_SUPABASE_URL = "https://supabase.test";
process.env.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY = "fake";
const fake = new FakePostgrest();
globalThis.fetch = fake.fetch as typeof fetch;
const db = createClient("https://supabase.test", "fake", { auth: { persistSession: false }, global: { fetch: fake.fetch as typeof fetch } });

const { DEMO_PORTAL_ID: D, moveAgents, runDemoAction } = await import("./demo.ts");
const { filterProspects, marketAction, MAX_MOVE, sortProspects } = await import("./demo-market.ts");
const { parseMarketQuery } = await import("./market-model.ts");

const OTHER = "11111111-1111-4111-8111-111111111111";
const agent = (id: string, o: Record<string, unknown> = {}) => ({
  id, full_name: `Agent ${id}`, preferred_email: `${id}@kw.test`, enriched_email: null, preferred_phone: "555-0100", brand: "Keller Williams", office_name: "KW Midtown",
  title: "Salesperson", office_city: "Atlanta", office_county: "Fulton", home_city: null, home_county: null, most_transacted_city: "Atlanta", most_transacted_county: "Fulton",
  sales_volume: 1_000_000, units: 4, est_time_in_industry_months: 60, ...o,
});

function seed() {
  fake.reset();
  fake.seed("agents", [
    agent("a1"), agent("a2", { brand: "Compass", office_name: "Compass Buckhead", sales_volume: 9_000_000, units: 20, est_time_in_industry_months: 240 }),
    agent("a3", { preferred_email: "a3@compass.test", brand: "Compass" }), agent("a4", { preferred_email: null, full_name: "Nomail Person" }),
  ]);
  fake.seed("client_agents", [{ client_id: OTHER, name: "Agent a1", email: "a1@kw.test" }]);
  fake.seed("client_dnc_entries", [
    { client_id: D, kind: "agent", name: "Agent a1", email: "A1@KW.TEST" },
    { client_id: OTHER, kind: "agent", name: "Agent a2", email: "a2@kw.test" },
  ]);
  fake.seed("client_pipeline_entries", []);
  fake.seed("os_demo_prospects", []);
}
const mine = (table: string) => fake.rows(table).filter((r) => r.client_id === D || r.portal_id === D);

test("Move to My Agents: off the DNC List it was on (an address in any case), onto My Agents by name — never the agent database's email", async () => {
  seed();
  const r = await moveAgents(db, ["a1", "a2"], "My Agents", "admin@outreachify.io");
  assert.deepEqual(r, { ok: true, message: "2 agents moved to My Agents." });
  assert.equal(mine("client_dnc_entries").length, 0, "a1 came off the Demo's DNC List");
  assert.deepEqual(mine("client_agents").map((x) => [x.name, x.email, x.phone, x.notes]), [["Agent a1", null, "555-0100", "From Market"], ["Agent a2", null, "555-0100", "From Market"]]);
  assert.equal(fake.rows("client_agents").filter((x) => x.client_id === OTHER).length, 1, "another portal's list untouched");
  assert.equal(fake.rows("client_dnc_entries").filter((x) => x.client_id === OTHER).length, 1);
  // Again: nobody twice.
  await moveAgents(db, ["a1"], "My Agents", null);
  assert.equal(mine("client_agents").length, 2);
  assert.deepEqual(fake.blocked, []);
});

test("Move to DNC List and to Prospects: each takes the agent off the other lists; Remove from all lists empties them", async () => {
  seed();
  await moveAgents(db, ["a2", "a4"], "My Agents", null);
  const r = await moveAgents(db, ["a2", "a4"], "DNC List", null);
  assert.equal(r.ok, true);
  assert.equal(mine("client_agents").length, 0, "matched by name when the entry has no address (a4)");
  assert.deepEqual(mine("client_dnc_entries").filter((x) => x.name !== "Agent a1").map((x) => [x.kind, x.name, x.email, x.brokerage]), [["agent", "Agent a2", null, "Compass"], ["agent", "Nomail Person", null, "Keller Williams"]]);
  await moveAgents(db, ["a2", "a3"], "Prospects", "eddy@brokerstaffer.com");
  assert.deepEqual(mine("os_demo_prospects").map((x) => [x.agent_id, x.added_by]).sort(), [["a2", "eddy@brokerstaffer.com"], ["a3", "eddy@brokerstaffer.com"]]);
  assert.ok(!mine("client_dnc_entries").some((x) => x.name === "Agent a2"), "a2 came off the DNC List");
  await moveAgents(db, ["a2"], "Prospects", null);
  assert.equal(mine("os_demo_prospects").length, 2, "an agent on Prospects already is not added twice — a plain insert of the new ones");
  const off = await moveAgents(db, ["a2", "a3", "a4"], "Not on a list", null);
  assert.deepEqual(off, { ok: true, message: "3 agents taken off every list." });
  assert.equal(mine("os_demo_prospects").length, 0);
  assert.ok(!mine("client_dnc_entries").some((x) => x.name === "Nomail Person"));
});

test("the Setup wizard's prospects leave out My Agents, the DNC List (people and company domains) and the pipeline", async () => {
  seed();
  // a1: on the DNC List as a person (seed); a2: on My Agents; a3: at a company on the DNC List; a4: in the pipeline (by name — no address).
  fake.seed("client_agents", [{ client_id: D, name: "Someone", email: "a2@kw.test" }]);
  fake.seed("client_dnc_entries", [
    { client_id: D, kind: "agent", name: "Agent a1", email: "A1@KW.TEST" },
    { client_id: D, kind: "company", name: "Compass", domain: "compass.test" },
  ]);
  fake.seed("client_pipeline_entries", [{ client_id: D, lead_name: "Nomail Person", lead_email: null }]);
  const r = await moveAgents(db, ["a1", "a2", "a3", "a4"], "Prospects", null, { onlyUnlisted: true });
  assert.deepEqual(r, { ok: true, message: "They're all on My Agents, your DNC List or your pipeline already — left out, as always." });
  assert.deepEqual(mine("os_demo_prospects"), []);
  assert.equal(mine("client_agents").length, 1, "nobody taken off My Agents");
  assert.equal(mine("client_dnc_entries").length, 2, "nobody taken off the DNC List");
  // Off My Agents and the person entry gone: a1 and a2 go in; the company still leaves a3 out.
  fake.seed("client_agents", []);
  fake.seed("client_dnc_entries", [{ client_id: D, kind: "company", name: "Compass", domain: "compass.test" }]);
  await moveAgents(db, ["a1", "a2", "a3"], "Prospects", null, { onlyUnlisted: true });
  assert.deepEqual(mine("os_demo_prospects").map((x) => x.agent_id).sort(), ["a1", "a2"]);
});

test("before migration 0041 a move to Prospects says so — and nothing is taken off any list first", async () => {
  seed();
  fake.missingTables.add("os_demo_prospects");
  const r = await moveAgents(db, ["a1"], "Prospects", null);
  assert.deepEqual(r, { ok: false, status: 409, error: "The Demo Portal's Prospects need migration 0041_demo_prospects.sql run first." });
  assert.equal(mine("client_dnc_entries").length, 1, "a1 still on the DNC List");
  fake.missingTables.clear();
});

test("the request: agent ids only, at most MAX_MOVE, one of the four lists; a query string of bounded length", () => {
  const ok = { type: "market.move", ids: ["a1"], to: "My Agents" };
  assert.equal(marketAction.safeParse(ok).success, true);
  for (const bad of [
    { ...ok, ids: [] }, { ...ok, ids: Array.from({ length: MAX_MOVE + 1 }, (_, i) => `a${i}`) }, { ...ok, ids: ["a1; drop"] }, { ...ok, to: "In your pipeline" },
    { type: "market.moveAll", list: "market", query: "x".repeat(4001), to: "Prospects" }, { type: "market.moveAll", list: "everything", query: "", to: "Prospects" },
  ]) assert.equal(marketAction.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
});

test("the Demo's Prospects page filters as Market does — ranges, brokerages, offices, places, title — and a name search only puts matches first", () => {
  const rows = [agent("a1"), agent("a2", { brand: "Compass", office_name: "Compass Buckhead", sales_volume: 9_000_000, units: 20, est_time_in_industry_months: 240, title: "Team Leader", home_city: "Decatur" }), agent("a3", { full_name: "Zed Smith", sales_volume: null })] as never[];
  const q = (s: string) => parseMarketQuery(new URLSearchParams(s));
  const ids = (s: string) => filterProspects(rows, q(s)).map((a: { id: string }) => a.id);
  assert.deepEqual(ids(""), ["a1", "a2", "a3"]);
  assert.deepEqual(ids("minVolume=5000000"), ["a2"], "a blank sales volume does not pass a minimum");
  assert.deepEqual(ids("maxUnits=10"), ["a1", "a3"]);
  assert.deepEqual(ids("minYears=10"), ["a2"]);
  assert.deepEqual(ids("brokerage=Compass"), ["a2"]);
  assert.deepEqual(ids("office=KW%20Midtown"), ["a1", "a3"]);
  assert.deepEqual(ids("city=Decatur"), ["a2"], "a home city counts");
  assert.deepEqual(ids("county=Fulton"), ["a1", "a2", "a3"]);
  assert.deepEqual(ids("title=Team%20Leader"), ["a2"]);
  // Include and exclude (23 Oct): left out by brokerage, office, place or title — an agent with nothing on record stays.
  assert.deepEqual(ids("xbrokerage=Compass"), ["a1", "a3"]);
  assert.deepEqual(ids("xoffice=KW%20Midtown"), ["a2"]);
  assert.deepEqual(ids("xcity=Decatur"), ["a1", "a3"], "a home city counts when leaving out, too");
  assert.deepEqual(ids("xcounty=Fulton"), [], "every one has Fulton somewhere");
  assert.deepEqual(ids("title=Salesperson&xtitle=Team%20Leader"), ["a1", "a3"]);
  assert.deepEqual(ids("brokerage=Keller%20Williams&xcity=Atlanta"), [], "include and exclude together");
  const titled = [agent("t1", { title: "Salesperson, Team Leader" }), agent("t2", { title: null }), agent("t3", { title: "sales person" })] as never[];
  const tids = (s: string) => filterProspects(titled, q(s)).map((a: { id: string }) => a.id);
  assert.deepEqual(tids("title=Salesperson"), ["t1", "t3"], "a title's parts, spacing and case aside — the agent database's rule");
  assert.deepEqual(tids("xtitle=Team%20Leader"), ["t2", "t3"], "no title on record stays");
  const sorted = (s: string) => sortProspects(filterProspects(rows, q(s)), q(s)).map((a: { id: string }) => a.id);
  assert.deepEqual(sorted("sort=volume&dir=desc"), ["a2", "a1", "a3"], "blanks last");
  assert.deepEqual(sorted("sort=volume&dir=desc&q=smith"), ["a3", "a2", "a1"], "a name match first");
});

test("the Edit form's custom fields: set, changed, cleared — on the Demo's own entry only", async () => {
  seed();
  const [e, theirs] = fake.seed("client_pipeline_entries", [
    { client_id: D, lead_name: "X", custom_fields_overrides: { "Coaching Status": "Active", Keep: "yes" } },
    { client_id: OTHER, lead_name: "Y", custom_fields_overrides: {} },
  ]);
  const r = await runDemoAction(db, { type: "entry.fields", id: e.id, fields: { "Coaching Status": "Paused", Keep: null, "New field": "v" } } as never, null);
  assert.equal(r.ok, true);
  assert.deepEqual(fake.rows("client_pipeline_entries").find((x) => x.id === e.id)!.custom_fields_overrides, { "Coaching Status": "Paused", "New field": "v" });
  const other = await runDemoAction(db, { type: "entry.fields", id: theirs.id, fields: { a: "b" } } as never, null);
  assert.equal(other.ok, false);
  assert.deepEqual(fake.rows("client_pipeline_entries").find((x) => x.id === theirs.id)!.custom_fields_overrides, {});
});
