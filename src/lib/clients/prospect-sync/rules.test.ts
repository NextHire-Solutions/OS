import { test } from "node:test";
import assert from "node:assert/strict";

import { agentMarkets, campaignPerMls, campaignResultSlackText, chunks, fence, latestPerAgent, parseByMls, prospectsSlackText, setupCampaignName, setupCampaignSlackText, severalMarkets, SLACK_NAMES, syncMode, tzLabel } from "./rules.ts";

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

test("Slack, one clean look: a bold title, one line per group (ten names, then +N more), who did it; [TEST] while fenced", () => {
  const added = Array.from({ length: 12 }, (_, i) => `Agent ${i + 1}`);
  assert.equal(prospectsSlackText({ client: "Homebase", who: "amy@brokerstaffer.com", added, removed: ["Sam Lee"], setup: false, campaign: null, test: false }), [
    "*Prospects updated · Homebase*",
    "• 12 added: Agent 1, Agent 2, Agent 3, Agent 4, Agent 5, Agent 6, Agent 7, Agent 8, Agent 9, Agent 10 +2 more",
    "• 1 removed: Sam Lee",
    "_by amy@brokerstaffer.com_",
  ].join("\n"));
  assert.match(prospectsSlackText({ client: "New Co", who: "c@new.test", added: ["A"], removed: [], setup: true, campaign: null, test: true }), /^\[TEST\] \*Prospects chosen in setup · New Co\*\n• 1 added: A\n_by c@new\.test_$/);
  assert.equal(setupCampaignSlackText({ client: "New Co", campaign: "New Co + Prospects", agents: 1200, test: true }), [
    "[TEST] *First campaign created · New Co*",
    "• New Co + Prospects: a draft, not launched",
    "• 1,200 agents from their setup going in",
    "_Next: write the emails from their offer, get them approved, then launch it._",
  ].join("\n"));
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

test("the 'Campaign updated' post: by campaign and by reason, removals' campaigns named (or counted past two), [TEST] while fenced; nothing to say → no post", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `A${i + 1}`, outcome: { kind: "added" as const, campaign: "Keyes + West (EST)" } }));
  const text = campaignResultSlackText({ client: "Keyes", test: false, outcomes: [
    ...many,
    { name: "R1", outcome: { kind: "removed", campaigns: ["Keyes 1 + West", "Keyes 2 + West", "Keyes 3 + West"] } },
    { name: "R2", outcome: { kind: "removed", campaigns: ["Keyes 1 + West"] } },
    { name: "K1", outcome: { kind: "already", campaign: "Keyes + Beaches" } },
    { name: "N1", outcome: { kind: "notAdded", reason: "no email on file" } },
    { name: "N2", outcome: { kind: "notAdded", reason: "no email on file" } },
    { name: "F1", outcome: { kind: "failed", action: "remove" } },
    { name: "Z1", outcome: { kind: "none" } },
  ] });
  assert.equal(text, [
    "*Campaign updated · Keyes*",
    "• 12 added to Keyes + West (EST): A1, A2, A3, A4, A5, A6, A7, A8, A9, A10 +2 more",
    "• 2 removed from 3 of their campaigns: R1, R2",
    "• 1 already in Keyes + Beaches: K1",
    "• 2 not added (no email on file): N1, N2",
    "• 1 couldn't be removed, team alerted: F1",
  ].join("\n"));
  assert.equal(campaignResultSlackText({ client: "K", test: true, outcomes: [{ name: "R", outcome: { kind: "removed", campaigns: ["K + Boston", "K + Cape"] } }] }), "[TEST] *Campaign updated · K*\n• 1 removed from K + Boston and K + Cape: R");
  assert.equal(campaignResultSlackText({ client: "K", test: false, outcomes: [{ name: "Z", outcome: { kind: "none" } }] }), null);
  assert.equal(campaignResultSlackText({ client: "K", test: false, outcomes: [] }), null);
});
