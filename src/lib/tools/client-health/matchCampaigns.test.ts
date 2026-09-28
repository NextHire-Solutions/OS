import { test } from "node:test";
import assert from "node:assert/strict";

import { autoMatchCampaignIds } from "./matchCampaigns";

const C = [
  { id: "1", name: "Spotlight + Triangle + ZF NS1 SEPT-2026" },
  { id: "2", name: "Spotlight - A Compass Team + Nicole + MLSPIN" },
  { id: "3", name: "Howe Realty + Nicole + Stellar" },
  { id: "4", name: "Unrelated Brokerage + Nicole" },
];

test("the client's name, contained in the campaign's, matches", () => {
  assert.deepEqual(autoMatchCampaignIds("Spotlight - A Compass Team", C), ["2"]);
});

test("an alias links a campaign named in a different pattern (the reason aliases exist)", () => {
  assert.deepEqual(autoMatchCampaignIds("Spotlight - A Compass Team", C, ["Spotlight + Triangle"]).sort(), ["1", "2"]);
});

test("Howe Realty Group: its alias covers what the removed hard-coded override matched", () => {
  assert.deepEqual(autoMatchCampaignIds("Howe Realty Group", C, ["Howe Realty"]), ["3"]);
  // Without the alias, the full name is not in the campaign name — which is why it has one.
  assert.deepEqual(autoMatchCampaignIds("Howe Realty Group", C), []);
});

test("blank aliases are ignored rather than matching everything", () => {
  assert.deepEqual(autoMatchCampaignIds("Unrelated Brokerage", C, ["", "   "]), ["4"]);
});
