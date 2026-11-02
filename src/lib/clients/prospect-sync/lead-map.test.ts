import { test } from "node:test";
import assert from "node:assert/strict";

import { databaseEmail, mapAgentToBisonLead, PRIORITY_ORDERS, type LeadAgent } from "./lead-map.ts";

/*
 * The lead is the Database app's worker's lead (enrich-worker.mjs mapAgentToBisonLead) — checked against 60 leads it
 * made on 20–22 Oct (scratchpad/audit/lead-parity.mts: 48 identical, the other 12 agents' data changed after the push,
 * 0 unexplained). These pin each rule it follows.
 */

const agent: LeadAgent = {
  id: "a1", first_name: null, last_name: null, full_name: "Jordan  Ellis Jr",
  buy_side_dollar: 1234567.4, list_side_dollar: null, office_city: "Austin", office_state: "TX", preferred_phone: "555-0100",
  sources: ["courted", "zillow"],
  source_ids: { zillow: { phone: "555-0111", city: "Round Rock", email: "Z@Zillow.test", office_name: "Zillow Office" }, courted: { city: null } },
  sales_volume: "2500000", approx_gci: 0, closed_rentals: null, most_transacted_city: "Austin", transacted_state: "TX", avg_sale_price: null,
  closed_transactions: 12, units: 7, stats_by_source: { zillow: { closed_transactions: 15, units: null } },
  office_name: "KW Austin", brand: "KW", preferred_email: null, enriched_email: null, enriched_email_status: null,
};

test("the worker's lead: names split, money as the worker writes it, each value by source priority, the Courted link always blank", () => {
  const lead = mapAgentToBisonLead(agent, "z@zillow.test", "ACTRIS");
  assert.equal(lead.first_name, "Jordan");
  assert.equal(lead.last_name, "Ellis Jr");
  assert.equal(lead.email, "z@zillow.test");
  // Courted is ahead of Zillow, and the agent is a Courted agent: the merged column wins over Zillow's office.
  assert.equal(lead.company, "KW Austin");
  assert.deepEqual(Object.fromEntries(lead.custom_variables.map((v) => [v.name, v.value])), {
    "buy-side": "$1,234,567",
    "list-side": "",
    "office city": "Austin, TX",
    "phone number": "555-0100",
    "sales volume": "$2,500,000",
    "estimated gci": "$0",
    "closed rentals": "0",
    "courted profile": "",
    "mls affiliation": "ACTRIS",
    "top producing city": "Austin, TX",
    "average sales price": "",
    // Per-source stats: Courted has none, Zillow has 15 — before the merged 12.
    "closed transactions": "15",
    // Zillow's units are null: on to the merged column.
    units: "7",
  });
  assert.deepEqual(lead.custom_variables.map((v) => v.name), ["buy-side", "list-side", "office city", "phone number", "sales volume", "estimated gci", "closed rentals", "courted profile", "mls affiliation", "top producing city", "average sales price", "closed transactions", "units"], "the worker's 13, in its order");
});

test("not a Courted agent: Zillow's own values come first; a lone name is first name with last name '-'", () => {
  const z: LeadAgent = { ...agent, full_name: "Cher", sources: ["zillow"], source_ids: { zillow: { phone: "555-0111", city: "Round Rock", office_name: "Zillow Office" } }, stats_by_source: null, transacted_state: null, brand: null };
  const lead = mapAgentToBisonLead(z, "c@x.test", null, PRIORITY_ORDERS.courted);
  assert.equal(lead.first_name, "Cher");
  assert.equal(lead.last_name, "-");
  assert.equal(lead.company, "Zillow Office");
  const v = Object.fromEntries(lead.custom_variables.map((x) => [x.name, x.value]));
  assert.equal(v["phone number"], "555-0111");
  assert.equal(v["top producing city"], "Round Rock");
  assert.equal(v["mls affiliation"], "");
  assert.equal(v["closed transactions"], "12");
});

test("the database's email, no check: a verified enrichment first, else by source priority; never one a check already failed", () => {
  assert.deepEqual(databaseEmail(agent), { email: "z@zillow.test" }, "Courted has none (the merged column is empty): Zillow's");
  assert.deepEqual(databaseEmail({ ...agent, preferred_email: "Pref@Agent.test" }), { email: "pref@agent.test" }, "a Courted agent's merged email");
  assert.deepEqual(databaseEmail({ ...agent, enriched_email: "Verified@Agent.test", enriched_email_status: "verified" }), { email: "verified@agent.test" });
  assert.deepEqual(databaseEmail({ ...agent, enriched_email: "Checked@Agent.test", enriched_email_status: "ok" }), { email: "checked@agent.test" }, "enrichment's \"ok\" (MillionVerifier's safe verdict) passed a check too");
  assert.deepEqual(databaseEmail({ ...agent, enriched_email: "maybe@agent.test", enriched_email_status: "catch_all" }), { email: "z@zillow.test" }, "only a passed check is preferred");
  assert.deepEqual(databaseEmail({ ...agent, enriched_email_status: "not_found" }), { skip: "its email already failed a check" });
  assert.deepEqual(databaseEmail({ ...agent, sources: [], source_ids: {}, preferred_email: null }), { skip: "no email in the agent database" });
  assert.deepEqual(databaseEmail({ ...agent, sources: [], source_ids: {}, preferred_email: "not-an-email" }), { skip: "no email in the agent database" });
});
