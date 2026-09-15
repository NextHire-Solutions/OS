/*
 * Instantly envelope → rows, and the keys that make replays idempotent.
 *
 *   node --test src/lib/tools/master-inbox/sync/instantly-rows.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bodyTextOf,
  deriveCustomFields,
  directionForEmail,
  historicalEmailRow,
  inboundMessageRow,
  leadEmailOf,
  leadFullName,
  messageExternalId,
  parseRecipients,
  stripHtml,
  threadExternalId,
} from "./instantly-rows.ts";
import type { InstantlyEmail, InstantlyWebhookEnvelope } from "../instantly/types.ts";

// The flat shape verified live in the tool, custom variables at top level.
const envelope: InstantlyWebhookEnvelope = {
  event_type: "reply_received",
  timestamp: "2026-09-15T14:03:00.000Z",
  workspace: "w-1",
  unibox_url: "https://app.instantly.ai/app/unibox?thread=abc",
  email_id: "e-123",
  reply_subject: "Re: Quick question",
  reply_text: "Sure, let's talk.",
  reply_text_snippet: "Sure, let's",
  reply_html: "<div>Sure, <b>let's</b> talk.</div>",
  email_account: "nicole@brokerstaffer.com",
  campaign_id: "c-9",
  campaign_name: "SERHANT. - NYC Agents",
  is_first: true,
  step: 2,
  variant: "A",
  lead_email: "jane@example.com",
  firstName: "Jane",
  lastName: "Doe",
  companyName: "Doe Realty",
  jobTitle: "Broker",
  LicenseNumber: "10401234567",
  GCI: "",
  // A custom variable Instantly sent as null — the index signature carries it.
  AgencyPhone: null,
};

test("idempotency keys: one thread per (lead, campaign), one message per email id", () => {
  assert.equal(threadExternalId("jane@example.com", "c-9"), "in:lead:jane@example.com:campaign:c-9");
  assert.equal(threadExternalId("jane@example.com", null), "in:lead:jane@example.com:campaign:none");
  assert.equal(threadExternalId("jane@example.com", undefined), "in:lead:jane@example.com:campaign:none");
  assert.equal(messageExternalId("e-123"), "in:email:e-123");
  // The webhook row and the /emails backfill row must collide on purpose.
  assert.equal(
    inboundMessageRow({ workspaceId: "ws", channelId: null, threadId: "t", emailId: "e-123", envelope, bodyText: null }).external_message_id,
    historicalEmailRow({ workspaceId: "ws", channelId: null, threadId: "t", email: { id: "e-123" } }).external_message_id,
  );
});

test("custom_fields keeps the enrichment and drops the reserved and empty keys", () => {
  const fields = deriveCustomFields(envelope);
  assert.deepEqual(fields, { jobTitle: "Broker", LicenseNumber: "10401234567" });
  for (const reserved of ["email_id", "reply_text", "campaign_id", "lead_email", "firstName", "companyName", "workspace"]) {
    assert.ok(!(reserved in fields), `${reserved} leaked into custom_fields`);
  }
  assert.ok(!("GCI" in fields), "empty string dropped");
  assert.ok(!("AgencyPhone" in fields), "null dropped");
});

test("lead identity: lead_email first, `email` as the alias", () => {
  assert.equal(leadEmailOf(envelope), "jane@example.com");
  assert.equal(leadEmailOf({ email: "alias@example.com" }), "alias@example.com");
  assert.equal(leadEmailOf({}), null);
  assert.equal(leadFullName(envelope), "Jane Doe");
  assert.equal(leadFullName({ firstName: "Jane" }), "Jane");
  assert.equal(leadFullName({}), null);
});

test("body text prefers reply_text, then stripped html, then the snippet", () => {
  assert.equal(bodyTextOf(envelope), "Sure, let's talk.");
  assert.equal(bodyTextOf({ reply_html: "<p>Hi <b>there</b></p><style>x{}</style>" }), "Hi there");
  assert.equal(bodyTextOf({ reply_text_snippet: "snippet" }), "snippet");
  assert.equal(bodyTextOf({}), null);
  assert.equal(stripHtml("<script>alert(1)</script><p>a   b</p>"), "a b");
});

test("the inbound message row", () => {
  const row = inboundMessageRow({
    workspaceId: "ws-1",
    channelId: "ch-1",
    threadId: "t-1",
    emailId: "e-123",
    envelope,
    bodyText: bodyTextOf(envelope),
  });
  assert.deepEqual(row, {
    workspace_id: "ws-1",
    thread_id: "t-1",
    channel_id: "ch-1",
    source_provider: "instantly",
    direction: "inbound",
    sender: "jane@example.com",
    recipients: { to: ["nicole@brokerstaffer.com"] },
    subject: "Re: Quick question",
    body_html: "<div>Sure, <b>let's</b> talk.</div>",
    body_text: "Sure, let's talk.",
    sent_at: "2026-09-15T14:03:00.000Z",
    external_message_id: "in:email:e-123",
    instantly_email_id: "e-123",
  });
  assert.ok(!("raw_payload" in row), "raw_payload is added on insert only — first write wins");
});

test("recipients: the JSON form wins over the CSV form", () => {
  assert.deepEqual(
    parseRecipients({ id: "x", to_address_email_list: "a@x.com, b@x.com", cc_address_email_list: "", bcc_address_email_list: null }),
    { to: ["a@x.com", "b@x.com"], cc: [], bcc: [] },
  );
  assert.deepEqual(
    parseRecipients({ id: "x", to_address_json: [{ address: "j@x.com", name: "J" }], to_address_email_list: "ignored@x.com" }),
    { to: ["j@x.com"], cc: [], bcc: [] },
  );
});

test("direction: by mailbox identity first, ue_type second, inbound by default", () => {
  const ours = "nicole@brokerstaffer.com";
  assert.equal(directionForEmail({ id: "1", from_address_email: "Nicole@BrokerStaffer.com", eaccount: ours, ue_type: 2 }), "outbound", "mailbox match beats ue_type");
  assert.equal(directionForEmail({ id: "2", from_address_email: "jane@example.com", eaccount: ours, ue_type: 2 }), "inbound");
  assert.equal(directionForEmail({ id: "3", ue_type: 1 }), "outbound");
  assert.equal(directionForEmail({ id: "4", ue_type: 3 }), "outbound", "ue_type 3 is a sent reply — the live quirk");
  assert.equal(directionForEmail({ id: "5" }), "inbound");
});

test("the historical /emails row", () => {
  const email: InstantlyEmail = {
    id: "e-7",
    timestamp_email: "2026-09-14T10:00:00.000Z",
    timestamp_created: "2026-09-14T10:00:05.000Z",
    subject: "Quick question",
    from_address_email: "nicole@brokerstaffer.com",
    from_address_json: [{ address: "nicole@brokerstaffer.com", name: "  Nicole at BrokerStaffer  " }],
    to_address_email_list: "jane@example.com",
    eaccount: "nicole@brokerstaffer.com",
    ue_type: 1,
    body: { html: "<p>Hello <i>Jane</i></p>" },
  };
  const row = historicalEmailRow({ workspaceId: "ws-1", channelId: "ch-1", threadId: "t-1", email });
  assert.equal(row.direction, "outbound");
  assert.equal(row.sender_name, "Nicole at BrokerStaffer");
  assert.equal(row.body_text, "Hello Jane", "text derived from html when the API omits it");
  assert.equal(row.sent_at, "2026-09-14T10:00:00.000Z", "timestamp_email before timestamp_created");
  assert.deepEqual(row.recipients, { to: ["jane@example.com"], cc: [], bcc: [] });
  assert.equal(row.external_message_id, "in:email:e-7");

  const long = historicalEmailRow({ workspaceId: "ws", channelId: null, threadId: "t", email: { id: "x", from_address_json: [{ address: "a@b.c", name: "n".repeat(300) }] } });
  assert.equal(long.sender_name?.length, 200, "display name is capped");
});
