import assert from "node:assert/strict";
import { test } from "node:test";

import { pickIntroChannel } from "./intro-sender.ts";

const E = "nicole.c@brokerstaffer.com";
const rows = [
  { id: "inst", provider: "instantly", status: "disconnected", display_name: E, instantly_account_id: E, external_account_id: null },
  { id: "eb-dead", provider: "emailbison", status: "disconnected", display_name: "Nicole Collins", instantly_account_id: null, external_account_id: E },
  { id: "eb-live", provider: "emailbison", status: "connected", display_name: "Nicole Collins", instantly_account_id: null, external_account_id: E },
  { id: "other", provider: "emailbison", status: "connected", display_name: "Nicole Collins", instantly_account_id: null, external_account_id: "nicole.collins@hirealtynow.com" },
];

test("an EmailBison conversation introduces from Nicole's live EmailBison mailbox, never a dead one or a campaign mailbox", () => {
  assert.deepEqual(pickIntroChannel(rows, "emailbison", E), { email: E, channelId: "eb-live", problem: null });
});

test("an Instantly conversation with Nicole disconnected there says so instead of failing the send", () => {
  const r = pickIntroChannel(rows, "instantly", E);
  assert.equal(r.channelId, null);
  assert.match(r.problem ?? "", /disconnected in Instantly/);
});

test("no mailbox on file for the platform", () => {
  assert.match(pickIntroChannel(rows.filter((r) => r.provider === "instantly"), "emailbison", E).problem ?? "", /not connected in EmailBison/);
});
