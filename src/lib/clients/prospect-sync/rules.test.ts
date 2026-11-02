import { test } from "node:test";
import assert from "node:assert/strict";

import { agentMarkets, campaignPerMls, chunks, fence, latestPerAgent, parseByMls, prospectsSlackText, setupCampaignName, setupCampaignSlackText, severalMarkets, SLACK_NAMES, syncMode, tzLabel } from "./rules.ts";

const P = "54322dcf-7392-4022-918c-990ebc8469b8";
const Q = "11111111-1111-4111-8111-111111111111";

test("off unless OS_PROSPECT_SYNC is exactly 1; the fence makes it a test for its portals only; the Demo never", () => {
  assert.equal(syncMode(P, false, {}), "off");
  assert.equal(syncMode(P, false, { OS_PROSPECT_SYNC: "true" }), "off");
  assert.equal(syncMode(P, false, { OS_PROSPECT_SYNC: "0" }), "off");
  assert.equal(syncMode(P, false, { OS_PROSPECT_SYNC: "1" }), "live");
  assert.equal(syncMode(P, false, { OS_PROSPECT_SYNC: " 1 " }), "live");
  assert.equal(syncMode(P, false, { OS_PROSPECT_SYNC: "1", OS_PROSPECT_SYNC_ONLY: ` ${P.toUpperCase()} , ${Q}` }), "test");
  assert.equal(syncMode(Q, false, { OS_PROSPECT_SYNC: "1", OS_PROSPECT_SYNC_ONLY: P }), "off");
  assert.equal(syncMode(P, true, { OS_PROSPECT_SYNC: "1" }), "off", "the Demo Portal");
  assert.equal(fence({ OS_PROSPECT_SYNC_ONLY: "  " }), null);
});

test("a new client's first campaign: '<Client> + <Market> + Prospects (<TZ>)' — client first, as the team names them", () => {
  assert.equal(setupCampaignName("Homebase", { areas: ["Greater Denver"], mls: ["REcolorado"] }, "America/Denver"), "Homebase + Greater Denver + Prospects (MST)");
  assert.equal(setupCampaignName("Premier Home Team", { areas: [], mls: ["CRMLS", "SANDICOR"] }, "America/Los_Angeles"), "Premier Home Team + CRMLS, SANDICOR + Prospects (PST)");
  assert.equal(setupCampaignName("BrokerStaffer", { areas: [], mls: [] }, null), "BrokerStaffer + Prospects");
  assert.equal(setupCampaignName("BrokerStaffer", { areas: [], mls: ["BRIGHT", "ABOR", "ARMLS", "FMLS"] }, "America/New_York"), "BrokerStaffer + Prospects (EST)", "a long MLS list is not a market name");
  assert.equal(setupCampaignName(" Keyes ", { areas: [" ", "South Florida"] }, "America/New_York"), "Keyes + South Florida + Prospects (EST)");
  assert.equal(tzLabel("America/Chicago"), "CST");
  assert.equal(tzLabel("America/Indiana/Knox"), "CST", "two of Indiana's zones are Central");
  assert.equal(tzLabel("America/Indiana/Tell_City"), "CST");
  assert.equal(tzLabel("America/Indiana/Indianapolis"), "EST");
  assert.equal(tzLabel("America/Phoenix"), "MST");
  assert.equal(tzLabel("Europe/London"), null);
});

test("Slack: who did it, who was added or removed (ten named, the rest counted), where they went — TEST while fenced", () => {
  const added = Array.from({ length: 12 }, (_, i) => `Agent ${i + 1}`);
  const t = prospectsSlackText({ client: "Homebase", who: "amy@brokerstaffer.com", added, removed: [], setup: false, campaign: "Homebase + Denver + Prospects (MST)", test: false });
  assert.match(t, /^🎯 {2}\*Prospects updated — Homebase\*/);
  assert.match(t, new RegExp(`➕ 12 agents added: Agent 1, .*Agent ${SLACK_NAMES} and 2 more`));
  assert.match(t, /Campaign: added to Homebase \+ Denver \+ Prospects \(MST\)\./);
  assert.match(t, /By amy@brokerstaffer\.com$/);
  const r = prospectsSlackText({ client: "Homebase", who: "x@y.test", added: [], removed: ["Sam Lee"], setup: false, campaign: null, test: true });
  assert.match(r, /^TEST — 🎯 {2}\*Prospects updated — Homebase\*/);
  assert.match(r, /➖ 1 agent removed: Sam Lee/);
  assert.match(r, /Campaign: taken out of Homebase's campaigns\./);
  assert.match(prospectsSlackText({ client: "New Co", who: "c@new.test", added: ["A"], removed: [], setup: true, campaign: null, test: false }), /chosen in setup — New Co[\s\S]*they go into New Co's Prospects campaign \(a client with none gets its first one, a draft, when it finishes setup\)\./);
  assert.match(setupCampaignSlackText({ client: "New Co", campaign: "New Co + Prospects", agents: 1200, test: true }), /^TEST — 🆕 {2}\*First campaign created — New Co\*\n {3}New Co \+ Prospects \(draft — not launched\)\n {3}1,200 agents/);
});

test("the latest wish per agent wins; the rest are set aside", () => {
  const rows = [{ id: 3, agent_id: "a" }, { id: 1, agent_id: "a" }, { id: 2, agent_id: "b" }, { id: 10, agent_id: "a" }];
  const { keep, superseded } = latestPerAgent(rows);
  assert.deepEqual(keep.map((r) => r.id).sort((x, y) => x - y), [2, 10]);
  assert.deepEqual(superseded.map((r) => r.id).sort((x, y) => x - y), [1, 3]);
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("several MLSs: a campaign per MLS — the stored picks read safely; an agent's MLSs in the client's order", () => {
  assert.equal(severalMarkets(["MLSPIN"]), false);
  assert.equal(severalMarkets([]), false);
  assert.equal(severalMarkets(["MLSPIN", "SOCAL"]), true);
  assert.deepEqual(parseByMls({ MLSPIN: { id: "1104", name: "Homebase + Boston" }, SOCAL: { id: 1103 }, BAD: { name: "no id" }, NONE: null, "": { id: "1" } }), {
    MLSPIN: { id: "1104", name: "Homebase + Boston" },
    SOCAL: { id: "1103", name: "1103" },
  });
  for (const v of [null, undefined, "x", 3, ["a"]]) assert.deepEqual(parseByMls(v), {});
  assert.deepEqual(agentMarkets(["NEREN", "SOCAL", "MLSPIN"], ["MLSPIN", "SOCAL"]), ["MLSPIN", "SOCAL"], "the client's order decides");
  assert.deepEqual(agentMarkets(["NEREN"], ["MLSPIN", "SOCAL"]), []);
});

test("a campaign per MLS for a client with several — never BrokerStaffer's own portal, whatever its MLSs (one campaign for all, 3 Nov)", () => {
  assert.equal(campaignPerMls("2944199b-bfbc-4e97-aeed-c38ba28f40b0", ["MLSPIN", "SOCAL"]), true);
  assert.equal(campaignPerMls("2944199b-bfbc-4e97-aeed-c38ba28f40b0", ["MLSPIN"]), false);
  assert.equal(campaignPerMls(P, ["BRIGHT", "ABOR", "ARMLS"]), false, "BrokerStaffer");
  assert.equal(campaignPerMls(null, ["A", "B"]), true);
});
