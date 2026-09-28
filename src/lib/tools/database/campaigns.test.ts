import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeCampaigns } from "./campaigns";

const bison = [
  { id: "101", name: "Acme + Nicole + MLSPIN", status: "active" },
  { id: "102", name: "Acme + Nicole + FMLS", status: "paused" },
];

test("EmailBison records come first and keep their status", () => {
  const out = mergeCampaigns(bison, [], null, true);
  assert.deepEqual(out.map((c) => [c.id, c.provider, c.status]), [["101", "EmailBison", "active"], ["102", "EmailBison", "paused"]]);
});

test("a campaign in both sources is listed once, with EmailBison's record", () => {
  const out = mergeCampaigns(bison, [{ id: "101", name: "stale name", provider: "EmailBison" }], null, true);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "Acme + Nicole + MLSPIN");
});

test("Instantly campaigns come only from the leads and never collide with an EmailBison id", () => {
  const out = mergeCampaigns(bison, [{ id: "101", name: "Acme Instantly", provider: "Instantly" }], null, true);
  assert.equal(out.length, 3);
  assert.deepEqual(out[2], { id: "101", name: "Acme Instantly", provider: "Instantly", status: null, leadsSynced: true });
});

test("leadsSynced: true only for campaigns that hold leads", () => {
  const out = mergeCampaigns(bison, [{ id: "102", name: "x", provider: "EmailBison" }], null, true);
  assert.equal(out.find((c) => c.id === "101")?.leadsSynced, false);
  assert.equal(out.find((c) => c.id === "102")?.leadsSynced, true);
});

test("leadsSynced is unknown (null) when the counts are unavailable — never a false 'not synced'", () => {
  for (const c of mergeCampaigns(bison, [], "999", false)) assert.equal(c.leadsSynced, null);
});

test("the legacy onboarding id is added only if not already listed", () => {
  assert.equal(mergeCampaigns(bison, [], "101", true).length, 2);
  const out = mergeCampaigns(bison, [], "555", true);
  assert.equal(out.length, 3);
  assert.equal(out[2].id, "555");
});

test("blank ids are dropped", () => {
  assert.equal(mergeCampaigns([{ id: "", name: "x", status: null }], [{ id: "", name: "y", provider: "Instantly" }], null, true).length, 0);
});

test("an unknown provider is treated as EmailBison", () => {
  assert.equal(mergeCampaigns([], [{ id: "7", name: "z", provider: "" }], null, true)[0].provider, "EmailBison");
});
