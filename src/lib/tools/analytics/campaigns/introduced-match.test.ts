import assert from "node:assert/strict";
import { test } from "node:test";

import { introducedFor, type IntroRow } from "./introduced-match.ts";

const row = (o: Partial<IntroRow>): IntroRow => ({ email: null, emailbison_lead_id: null, campaign_id: null, client_id: null, voided: false, ...o });

test("this campaign's introductions count by lead id and email", () => {
  const s = introducedFor([row({ email: "Ann@X.com", emailbison_lead_id: "101", campaign_id: 255, client_id: "c1" })], 255, ["c1"], "emailbison");
  assert.deepEqual(s, { leadIds: [101], emails: ["ann@x.com"] });
});

test("another campaign's introduction does not count here", () => {
  const s = introducedFor([row({ email: "bob@x.com", emailbison_lead_id: 7, campaign_id: "298", client_id: "c1" })], 255, ["c1"], "emailbison");
  assert.deepEqual(s, { leadIds: [], emails: [] });
});

test("no-campaign introductions count by email only, and only for the campaign's own client", () => {
  const rows = [
    row({ email: "cat@x.com", campaign_id: null, client_id: "c1" }),
    row({ email: "dan@x.com", campaign_id: "", client_id: "c2" }),
    row({ email: null, campaign_id: null, client_id: "c1" }),
  ];
  assert.deepEqual(introducedFor(rows, 255, ["c1"], "emailbison"), { leadIds: [], emails: ["cat@x.com"] });
});

test("cancelled introductions never count", () => {
  const s = introducedFor([row({ email: "eve@x.com", emailbison_lead_id: 5, campaign_id: 255, voided: true })], 255, [], "emailbison");
  assert.deepEqual(s, { leadIds: [], emails: [] });
});

test("Instantly: campaign uuids match case-insensitively, and lead ids are ignored", () => {
  const s = introducedFor([row({ email: "fay@x.com", emailbison_lead_id: 9, campaign_id: "DF330FA7-F323-4383-9B7D-A4ACA28E35D4" })], "df330fa7-f323-4383-9b7d-a4aca28e35d4", [], "instantly");
  assert.deepEqual(s, { leadIds: [], emails: ["fay@x.com"] });
});

test("duplicates collapse and bad lead ids are dropped", () => {
  const rows = [
    row({ email: "gus@x.com", emailbison_lead_id: "12", campaign_id: 255 }),
    row({ email: "GUS@x.com ", emailbison_lead_id: 12, campaign_id: "255" }),
    row({ email: "hal@x.com", emailbison_lead_id: "abc", campaign_id: 255 }),
  ];
  assert.deepEqual(introducedFor(rows, 255, [], "emailbison"), { leadIds: [12], emails: ["gus@x.com", "hal@x.com"] });
});
