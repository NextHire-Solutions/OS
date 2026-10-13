import { test } from "node:test";
import assert from "node:assert/strict";

import { clientCampaignCounts } from "./campaign-counts.ts";

const m = (campaign_id: string | number, client_id: string | null, extra: Partial<{ excluded: boolean; match_method: string }> = {}) => ({
  campaign_id,
  client_id,
  excluded: false,
  ...extra,
});

test("counts a client's live campaigns across both platforms", () => {
  const counts = clientCampaignCounts({
    emailbison: [m(1, "a"), m(2, "a", { match_method: "manual" }), m(3, "b")],
    instantly: [m("u1", "a")],
    liveEmailbison: [1, 2, 3],
    liveInstantly: ["u1"],
  });
  assert.deepEqual(counts.get("a"), { total: 3, manual: 1, instantly: 1 });
  assert.deepEqual(counts.get("b"), { total: 1, manual: 0, instantly: 0 });
});

test("an archived Instantly campaign is not one of the client's campaigns", () => {
  // The reported case: every Instantly campaign archived, mappings still there.
  const counts = clientCampaignCounts({
    emailbison: [m(1, "a")],
    instantly: [m("u1", "a"), m("u2", "a"), m("u3", "a")],
    liveEmailbison: [1],
    liveInstantly: [],
  });
  assert.deepEqual(counts.get("a"), { total: 1, manual: 0, instantly: 0 });
});

test("a campaign deleted in EmailBison is not counted either", () => {
  const counts = clientCampaignCounts({
    emailbison: [m(1, "a"), m(2, "a", { match_method: "manual" })],
    instantly: [],
    liveEmailbison: [1],
    liveInstantly: [],
  });
  assert.deepEqual(counts.get("a"), { total: 1, manual: 0, instantly: 0 });
});

test("a client whose campaigns are all gone has no entry — the screen shows 0", () => {
  const counts = clientCampaignCounts({ emailbison: [m(9, "a")], instantly: [m("u9", "a")], liveEmailbison: [], liveInstantly: [] });
  assert.equal(counts.get("a"), undefined);
});

test("excluded and unassigned mappings are never counted", () => {
  const counts = clientCampaignCounts({
    emailbison: [m(1, "a", { excluded: true }), m(2, null)],
    instantly: [m("u1", "a", { excluded: true })],
    liveEmailbison: [1, 2],
    liveInstantly: ["u1"],
  });
  assert.equal(counts.size, 0);
});

test("ids match whether the database hands them over as numbers or text", () => {
  const counts = clientCampaignCounts({ emailbison: [m("7", "a")], instantly: [], liveEmailbison: [7], liveInstantly: [] });
  assert.equal(counts.get("a")?.total, 1);
});
