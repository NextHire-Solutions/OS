import { test } from "node:test";
import assert from "node:assert/strict";

import { NO_CAMPAIGN, campaignIdsWithTags, narrowByTags, tagNames, tagOptions } from "./tag-filter-rule.ts";

const tag = (name: string) => ({ id: 1, name, default: false });
const CAMPAIGNS = [
  { id: 11, tags: [tag("Recruiting"), tag("West")] },
  { id: 12, tags: [tag("recruiting")] },
  { id: 13, tags: [tag("Referral")] },
  { id: 14, tags: [] },
  { id: 15, tags: null },
  { id: 16, tags: "Recruiting" },
];

const none = { tags: [] as string[], campaignIds: [] as string[], emailbisonCampaignIds: [] as number[], instantlyCampaignIds: [] as string[] };

test("tag names: read from EmailBison's tag objects; anything malformed is no tags", () => {
  assert.deepEqual(tagNames([tag("Recruiting"), tag(" West ")]), ["Recruiting", "West"]);
  assert.deepEqual(tagNames(["Plain"]), ["Plain"]);
  assert.deepEqual(tagNames([{ name: "" }, { name: 5 }, null, 7, {}]), []);
  assert.deepEqual(tagNames(null), []);
  assert.deepEqual(tagNames("Recruiting"), []);
  assert.deepEqual(tagNames({ name: "Recruiting" }), []);
});

test("options: every tag in use once, whatever its case, most campaigns first", () => {
  assert.deepEqual(tagOptions(CAMPAIGNS), [
    { value: "Recruiting", label: "Recruiting", hint: "2 campaigns" },
    { value: "Referral", label: "Referral", hint: "1 campaign" },
    { value: "West", label: "West", hint: "1 campaign" },
  ]);
});

test("options: a tag listed twice on one campaign counts that campaign once", () => {
  assert.deepEqual(tagOptions([{ id: 1, tags: [tag("A"), tag("a")] }]), [{ value: "A", label: "A", hint: "1 campaign" }]);
});

test("campaigns with a tag: any of the chosen tags, any case", () => {
  assert.deepEqual(campaignIdsWithTags(CAMPAIGNS, ["RECRUITING"]), [11, 12]);
  assert.deepEqual(campaignIdsWithTags(CAMPAIGNS, ["West", "Referral"]), [11, 13]);
  assert.deepEqual(campaignIdsWithTags(CAMPAIGNS, ["Nobody"]), []);
  assert.deepEqual(campaignIdsWithTags(CAMPAIGNS, []), []);
  assert.deepEqual(campaignIdsWithTags(CAMPAIGNS, ["  "]), []);
});

test("no tag chosen: the filters are handed back untouched", () => {
  const f = { ...none, campaignIds: ["11"], emailbisonCampaignIds: [11] };
  assert.equal(narrowByTags(f, [11, 12]), f);
});

test("a tag alone becomes its campaigns", () => {
  const out = narrowByTags({ ...none, tags: ["Recruiting"] }, [11, 12]);
  assert.deepEqual(out.emailbisonCampaignIds, [11, 12]);
  assert.deepEqual(out.campaignIds, ["11", "12"]);
  assert.deepEqual(out.instantlyCampaignIds, []);
  assert.deepEqual(out.tags, ["Recruiting"], "the selection itself is kept for the screen");
});

test("a tag with campaigns chosen: only the chosen campaigns that carry it", () => {
  const out = narrowByTags({ ...none, tags: ["Recruiting"], campaignIds: ["11", "13"], emailbisonCampaignIds: [11, 13] }, [11, 12]);
  assert.deepEqual(out.emailbisonCampaignIds, [11]);
});

test("a tag that matches nothing shows nothing — never everything", () => {
  const out = narrowByTags({ ...none, tags: ["Nobody"] }, []);
  assert.deepEqual(out.emailbisonCampaignIds, [NO_CAMPAIGN]);
  assert.deepEqual(out.campaignIds, [String(NO_CAMPAIGN)]);
  assert.ok(out.emailbisonCampaignIds.length > 0, "an empty list would mean 'no restriction' to the SQL");
});

test("chosen campaigns none of which carry the tag: nothing", () => {
  const out = narrowByTags({ ...none, tags: ["Recruiting"], campaignIds: ["13"], emailbisonCampaignIds: [13] }, [11, 12]);
  assert.deepEqual(out.emailbisonCampaignIds, [NO_CAMPAIGN]);
});

test("Instantly campaigns carry no tags: a tag takes them out, and an Instantly-only selection is nothing", () => {
  const uuid = "0b1c2d3e-0000-4000-8000-000000000001";
  const mixed = narrowByTags({ ...none, tags: ["Recruiting"], campaignIds: ["11", uuid], emailbisonCampaignIds: [11], instantlyCampaignIds: [uuid] }, [11, 12]);
  assert.deepEqual(mixed.emailbisonCampaignIds, [11]);
  assert.deepEqual(mixed.instantlyCampaignIds, []);
  const only = narrowByTags({ ...none, tags: ["Recruiting"], campaignIds: [uuid], instantlyCampaignIds: [uuid] }, [11, 12]);
  assert.deepEqual(only.emailbisonCampaignIds, [NO_CAMPAIGN], "not 'every tagged campaign' — the user chose a campaign");
  assert.deepEqual(only.instantlyCampaignIds, []);
});
