import { test } from "node:test";
import assert from "node:assert/strict";

import { leadsToTransfer, planLeads, statusLabel, type CampaignLeadRow } from "./leads.ts";

const OLD = 1277;
/** A lead as EmailBison listed it on 19 Nov: its own status, and a row per campaign it is on. */
const lead = (id: number, here: string | null, others: Array<[number, string]> = [], leadStatus = "unverified"): CampaignLeadRow => ({
  id,
  email: `l${id}@x.com`,
  status: leadStatus,
  lead_campaign_data: [
    ...(here === null ? [] : [{ campaign_id: OLD, status: here, status_reason: null }]),
    ...others.map(([campaign_id, status]) => ({ campaign_id, status, status_reason: null })),
  ],
});

test("In Sequence is moved, Sequence Finished is copied, the rest stay", () => {
  const plan = planLeads(OLD, [
    lead(1, "in_sequence"),
    lead(2, "sequence_finished"),
    lead(3, "stopped"),
    lead(4, "replied"),
    lead(5, "never_contacted"),
  ]);
  assert.deepEqual(plan.move, [1]);
  assert.deepEqual(plan.copy, [2]);
  assert.deepEqual(plan.left, { stopped: 1, replied: 1, never_contacted: 1 });
  assert.equal(plan.total, 5);
  assert.equal(leadsToTransfer(plan), 2);
});

test("a PAUSED old campaign: its In Sequence leads read sending_paused and are still moved (measured 19 Nov)", () => {
  const plan = planLeads(OLD, [lead(1, "sending_paused"), lead(2, "sending_paused")]);
  assert.deepEqual(plan.move, [1, 2]);
});

test("the user, 19 Nov: a lead another campaign is also emailing is moved/copied too, and counted as such", () => {
  const plan = planLeads(OLD, [
    lead(1, "in_sequence", [[900, "in_sequence"]]),
    lead(2, "sequence_finished", [[901, "in_sequence"], [902, "in_sequence"]]),
    lead(3, "in_sequence", [[903, "sequence_finished"], [904, "stopped"]]),
  ]);
  assert.deepEqual(plan.move, [1, 3]);
  assert.deepEqual(plan.copy, [2]);
  assert.deepEqual(plan.busy, { move: 1, copy: 1, examples: [{ id: 1, email: "l1@x.com", campaignIds: [900] }, { id: 2, email: "l2@x.com", campaignIds: [901, 902] }] });
});

test("a lead paused part-way on another campaign is not counted as busy (EmailBison: paused campaigns don't count)", () => {
  const plan = planLeads(OLD, [lead(1, "sequence_finished", [[900, "sending_paused"]])]);
  assert.deepEqual(plan.copy, [1]);
  assert.equal(plan.busy.copy, 0, "paused elsewhere is not counted as being emailed");
});

test("a bounced or unsubscribed lead is left whatever it reads here", () => {
  const plan = planLeads(OLD, [lead(1, "sequence_finished", [], "bounced"), lead(2, "in_sequence", [], "Unsubscribed")]);
  assert.deepEqual(plan.move, []);
  assert.deepEqual(plan.copy, []);
  assert.deepEqual(plan.left, { bounced: 1, unsubscribed: 1 });
});

test("no duplicates: a lead listed twice is counted and transferred once", () => {
  const plan = planLeads(OLD, [lead(1, "in_sequence"), lead(1, "in_sequence"), lead(2, "sequence_finished"), lead(2, "sequence_finished")]);
  assert.deepEqual(plan.move, [1]);
  assert.deepEqual(plan.copy, [2]);
  assert.equal(plan.total, 2);
});

test("statuses are read case- and space-insensitively; campaign ids may come as strings", () => {
  const row: CampaignLeadRow = { id: 7, status: "Verified", lead_campaign_data: [{ campaign_id: String(OLD), status: " In_Sequence " }, { campaign_id: "55", status: "IN_SEQUENCE" }] };
  const plan = planLeads(OLD, [row]);
  assert.equal(plan.busy.move, 1, "busy on campaign '55'");
  assert.deepEqual(plan.move, [7], "and moved anyway");
  const free = planLeads(OLD, [{ id: 8, lead_campaign_data: [{ campaign_id: String(OLD), status: "Sequence_Finished" }] }]);
  assert.deepEqual(free.copy, [8]);
});

test("a row with no entry for this campaign, a bad id, or no data is never transferred", () => {
  const plan = planLeads(OLD, [lead(1, null, [[900, "sequence_finished"]]), { id: 0 }, { id: -3 }, { id: 4 }]);
  assert.deepEqual(plan.move, []);
  assert.deepEqual(plan.copy, []);
  assert.deepEqual(plan.left, { unknown: 2 });
  assert.equal(plan.total, 2);
});

test("only five examples of busy leads are kept, all are counted", () => {
  const rows = Array.from({ length: 12 }, (_, i) => lead(i + 1, "in_sequence", [[900, "in_sequence"]]));
  const plan = planLeads(OLD, rows);
  assert.equal(plan.busy.move, 12);
  assert.equal(plan.busy.examples.length, 5);
  assert.equal(plan.move.length, 12, "all of them moved");
});

test("statusLabel", () => {
  assert.equal(statusLabel("never_contacted"), "Never contacted");
  assert.equal(statusLabel("stopped"), "Sequence stopped");
  assert.equal(statusLabel("replied"), "Replied");
  assert.equal(statusLabel(""), "Unknown");
});
