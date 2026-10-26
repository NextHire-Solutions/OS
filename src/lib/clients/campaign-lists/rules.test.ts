/*
 * My Agents and DNC → off the client's own campaigns: the rules, without a
 * database or a campaign platform.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  afterCursor,
  campaignMode,
  compareEntries,
  entryTarget,
  liveOnlyCampaigns,
  normalEmail,
  overallStatus,
  planRemovals,
  portalOwners,
  type CampaignOutcome,
} from "./rules.ts";

test("only a real address counts, lower-cased", () => {
  assert.equal(normalEmail("  Jane.Doe@Example.COM "), "jane.doe@example.com");
  for (const v of [null, undefined, "", "jane", "jane@", "@x.com", "jane doe@x.com", 5]) assert.equal(normalEmail(v), null);
});

test("a company DNC entry and a name-only entry take nothing off a campaign", () => {
  assert.deepEqual(entryTarget({ email: "a@b.com", kind: "company" }, "dnc"), { ok: false, reason: "company" });
  assert.deepEqual(entryTarget({ email: null, kind: "agent" }, "dnc"), { ok: false, reason: "no_email" });
  assert.deepEqual(entryTarget({ email: "None", kind: "agent" }, "dnc"), { ok: false, reason: "no_email" });
  assert.deepEqual(entryTarget({ email: "A@B.com", kind: "agent" }, "dnc"), { ok: true, email: "a@b.com" });
  // My Agents rows carry no kind; "company" there is not a thing.
  assert.deepEqual(entryTarget({ email: "a@b.com" }, "my_agents"), { ok: true, email: "a@b.com" });
});

test("a portal belongs to its linked client, else to the ONE client its name fits", () => {
  const clients = [
    { id: "c1", name: "SERHANT.", aliases: ["SERHANT. PA 15M+"], miClientId: "m1" },
    { id: "c2", name: "Keyes", aliases: [], miClientId: "m2" },
    { id: "c3", name: "Twin", aliases: [], miClientId: null },
    { id: "c4", name: "Twin", aliases: [], miClientId: null },
  ];
  const rows = [
    { id: "m1", name: "anything" },
    { id: "m2", name: "Keyes" },
    { id: "m3", name: "Serhant. PA 15M+" },
    { id: "m4", name: "Twin" },
    { id: "m5", name: "Nobody" },
    { id: "m6", name: "Keyes", slug: "unknown" },
  ];
  const owners = portalOwners(rows, clients);
  assert.equal(owners.get("m1"), "c1");
  assert.equal(owners.get("m2"), "c2");
  assert.equal(owners.get("m3"), "c1", "a second portal by alias");
  assert.equal(owners.has("m4"), false, "two clients share the name — neither is guessed");
  assert.equal(owners.has("m5"), false);
  assert.equal(owners.has("m6"), false, "the unknown bucket is nobody's");
});

test("only the client's own campaigns, and only an exact address", () => {
  const campaigns = [{ id: "642", name: "Keyes + West Florida", status: "active" }, { id: "700", name: "Keyes + Miami", status: "paused" }];
  const leads = [
    { id: 1, email: "Jane@x.com", campaigns: [{ campaignId: 642, status: "in_sequence" }, { campaignId: 999, status: "in_sequence" }, { campaignId: 700, status: "sequence_finished" }] },
    { id: 2, email: "jane@x.com.au", campaigns: [{ campaignId: 642, status: "in_sequence" }] },
  ];
  assert.deepEqual(planRemovals("jane@x.com", leads, campaigns), [
    { campaignId: "642", campaignName: "Keyes + West Florida", leadId: 1, leadStatus: "in_sequence" },
    { campaignId: "700", campaignName: "Keyes + Miami", leadId: 1, leadStatus: "sequence_finished" },
  ]);
  assert.deepEqual(planRemovals("jane@x.com", leads, []), [], "a client with no campaigns loses nobody");
});

test("live needs every switch; each default is practice", () => {
  const on = { enabled: true, practiceMode: false };
  const env = { OS_CAMPAIGN_CLEANUP_LIVE: "1" };
  assert.deepEqual(campaignMode(on, true, "642", env), { live: true });
  assert.deepEqual(campaignMode({ enabled: true, practiceMode: true }, true, "642", env), { live: false, reason: "practice_mode" });
  assert.deepEqual(campaignMode(on, true, "642", {}), { live: false, reason: "server_locked" });
  assert.deepEqual(campaignMode(on, true, "642", { OS_CAMPAIGN_CLEANUP_LIVE: "true" }), { live: false, reason: "server_locked" }, "exactly 1");
  assert.deepEqual(campaignMode(on, false, "642", env), { live: false, reason: "client_off" });
  assert.deepEqual(campaignMode(on, true, "642", { ...env, OS_CAMPAIGN_CLEANUP_LIVE_ONLY: "700, 701" }), { live: false, reason: "outside_fence" });
  assert.deepEqual(campaignMode(on, true, "700", { ...env, OS_CAMPAIGN_CLEANUP_LIVE_ONLY: "700, 701" }), { live: true });
});

test("a fence set to nothing valid lets nothing through", () => {
  assert.equal(liveOnlyCampaigns({}), null);
  assert.deepEqual(liveOnlyCampaigns({ OS_CAMPAIGN_CLEANUP_LIVE_ONLY: "" }), []);
  assert.deepEqual(liveOnlyCampaigns({ OS_CAMPAIGN_CLEANUP_LIVE_ONLY: "abc, 12x" }), []);
  assert.deepEqual(campaignMode({ enabled: true, practiceMode: false }, true, "642", { OS_CAMPAIGN_CLEANUP_LIVE: "1", OS_CAMPAIGN_CLEANUP_LIVE_ONLY: "abc" }), { live: false, reason: "outside_fence" });
});

test("the entry's status follows its campaigns", () => {
  const o = (outcome: CampaignOutcome["outcome"]): CampaignOutcome => ({ campaignId: "1", campaignName: "x", leadId: 1, leadStatus: null, outcome });
  assert.equal(overallStatus([]), "not_in_campaigns");
  assert.equal(overallStatus([o("would_remove")]), "practice");
  assert.equal(overallStatus([o("removed"), o("already_off")]), "removed");
  assert.equal(overallStatus([o("removed"), o("would_remove")]), "partly_removed");
  assert.equal(overallStatus([o("removed"), o("failed")]), "partly_removed");
  assert.equal(overallStatus([o("failed"), o("would_remove")]), "failed");
});

test("the cursor never skips a row that shares a bulk import's timestamp", () => {
  const at = "2026-10-26T10:00:00.000Z";
  assert.equal(afterCursor({ created_at: at, id: "b" }, { at, id: "a" }), true);
  assert.equal(afterCursor({ created_at: at, id: "a" }, { at, id: "a" }), false);
  assert.equal(afterCursor({ created_at: "2026-10-26T10:00:00+00:00", id: "a" }, { at, id: null }), true, "the switch's own moment: nothing at it was processed yet");
  assert.equal(afterCursor({ created_at: "2026-10-26T09:59:59.999Z", id: "z" }, { at, id: null }), false);
});

test("microseconds order rows that milliseconds would call equal", () => {
  const a = { created_at: "2026-10-26T10:00:00.123401+00:00", id: "z" };
  const b = { created_at: "2026-10-26T10:00:00.123402+00:00", id: "a" };
  assert.equal(compareEntries(a, b), -1);
  assert.equal(afterCursor(b, { at: a.created_at, id: a.id }), true);
  assert.equal(afterCursor(a, { at: b.created_at, id: b.id }), false);
  assert.equal(compareEntries({ created_at: "2026-10-26T10:00:00Z", id: "a" }, { created_at: "2026-10-26T10:00:00.000000+00:00", id: "b" }), -1, "same moment, ordered by id");
});

test("the log line says what happened, in words", async () => {
  const { removalLine } = await import("./rules.ts");
  const c = (outcome: string, extra: Record<string, unknown> = {}) => ({ campaignId: "642", campaignName: "Keyes + West Florida", leadId: 1, leadStatus: null, outcome, ...extra }) as never;
  assert.equal(removalLine({ status: "practice", reason: null, campaigns: [c("would_remove", { reason: "Practice mode is on." })] }), "Practice — would come off 1 campaign: Keyes + West Florida. Practice mode is on.");
  assert.equal(removalLine({ status: "removed", reason: null, campaigns: [c("removed"), c("already_off", { campaignName: "Keyes + Miami" })] }), "Removed from 2 campaigns: Keyes + West Florida, Keyes + Miami.");
  assert.match(removalLine({ status: "skipped", reason: "A company entry.", campaigns: [] }), /^Skipped — A company entry/);
  assert.match(removalLine({ status: "failed", reason: null, campaigns: [c("failed", { error: "422" })] }), /Failed on Keyes \+ West Florida: 422/);
});

test("the log's detail lists each campaign once, grouped — never one long sentence", async () => {
  const { removalGroups } = await import("./rules.ts");
  const c = (outcome: string, name: string, extra: Record<string, unknown> = {}) => ({ campaignId: name, campaignName: name, leadId: 1, leadStatus: null, outcome, ...extra }) as never;
  const long = "Jeff Cook Real Estate LPT Realty 1 + Nicole + West Ashley, North Charleston, Mount Pleasant";
  assert.deepEqual(removalGroups({ status: "practice", reason: null, campaigns: [c("would_remove", long, { reason: "Practice mode is on." }), c("would_remove", "B", { reason: "Practice mode is on." })] }), [
    { label: "Would come off 2 campaigns", names: [long, "B"], note: "Practice mode is on." },
  ]);
  assert.deepEqual(removalGroups({ status: "partly_removed", reason: null, campaigns: [c("removed", "A"), c("already_off", "B"), c("failed", "C", { error: "422" })] }), [
    { label: "Off 2 campaigns", names: ["A", "B"], note: null },
    { label: "Failed on 1 campaign", names: ["C"], note: "422" },
  ]);
  assert.deepEqual(removalGroups({ status: "not_in_campaigns", reason: null, campaigns: [] }), [], "the chip says it all");
  assert.deepEqual(removalGroups({ status: "skipped", reason: "A company entry.", campaigns: [] }), [{ label: "A company entry.", names: [], note: null }]);
  assert.deepEqual(removalGroups({ status: "pending", reason: null, campaigns: [] }), []);
});

test("the Prospects campaign is pre-selected: the newest sending one, never a finished one", async () => {
  const { suggestProspectsCampaign, campaignChoiceOrder, campaignStatusWord } = await import("./rules.ts");
  const c = (id: string, status: string) => ({ id, status, name: `#${id}` });
  assert.equal(suggestProspectsCampaign([c("10", "active"), c("42", "active"), c("99", "paused"), c("120", "completed")])?.id, "42", "newest sending, over a newer paused or finished one");
  assert.equal(suggestProspectsCampaign([c("10", "draft"), c("11", "paused")])?.id, "11", "nothing sending: paused before draft");
  assert.equal(suggestProspectsCampaign([c("10", "completed"), c("11", "archived")]), null, "only finished ones: nothing is suggested");
  assert.equal(suggestProspectsCampaign([]), null);
  assert.deepEqual(campaignChoiceOrder([c("10", "completed"), c("11", "draft"), c("12", "active"), c("13", "active")]).map((x) => x.id), ["13", "12", "11", "10"]);
  assert.equal(campaignStatusWord("active"), "Sending");
  assert.equal(campaignStatusWord("completed"), "Finished");
});
