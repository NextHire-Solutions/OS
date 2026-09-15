/*
 * EmailBison envelope → rows, and the keys that make replays idempotent.
 *
 *   node --test src/lib/tools/master-inbox/sync/emailbison-rows.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  inboundFromReply,
  leadFields,
  normalizeRecipientList,
  replyExternalId,
  scheduledExternalId,
  threadExternalId,
  unwrapEnvelope,
} from "./emailbison-rows.ts";
import type { EmailBisonReply } from "../emailbison/types.ts";

test("idempotency keys: thread per (lead, campaign); reply and scheduled ids never collide", () => {
  assert.equal(threadExternalId(42, 5), "eb:lead:42:campaign:5");
  assert.equal(threadExternalId(42, undefined), "eb:lead:42:campaign:none");
  assert.equal(threadExternalId(42, 0), "eb:lead:42:campaign:none", "0 is not a campaign");
  assert.equal(replyExternalId(99), "eb:reply:99");
  assert.equal(scheduledExternalId(99), "eb:sched:99");
  assert.notEqual(replyExternalId(99), scheduledExternalId(99));
});

test("the envelope is accepted both unwrapped (live) and wrapped (the OpenAPI sample)", () => {
  const event = { type: "LEAD_REPLIED", workspace_id: 7 };
  const data = { lead: { id: 1, uuid: "u", email: "a@b.c" } };

  const live = unwrapEnvelope({ event, data });
  assert.equal(live.eventType, "lead_replied", "lower-cased");
  assert.equal(live.eventBlock?.workspace_id, 7);
  assert.deepEqual(live.payload, data);

  const wrapped = unwrapEnvelope({ data: { event, data } });
  assert.equal(wrapped.eventType, "lead_replied");
  assert.deepEqual(wrapped.payload, data);

  assert.equal(unwrapEnvelope({}).eventType, undefined);
  assert.deepEqual(unwrapEnvelope({}).payload, {});
});

test("recipient lists: every shape EmailBison has shipped", () => {
  assert.deepEqual(normalizeRecipientList([{ name: "J", address: "j@x.com" }, { email: "k@x.com" }, { name: "no address" }]), ["j@x.com", "k@x.com"]);
  assert.deepEqual(normalizeRecipientList(["a@x.com", " b@x.com ", "not-an-email"]), ["a@x.com", "b@x.com"]);
  assert.deepEqual(normalizeRecipientList("a@x.com, b@x.com; c@x.com"), ["a@x.com", "b@x.com", "c@x.com"]);
  assert.deepEqual(normalizeRecipientList(null), []);
  assert.deepEqual(normalizeRecipientList(undefined), []);
  assert.deepEqual(normalizeRecipientList(42), []);
});

test("lead fields flatten custom_variables into custom_fields", () => {
  assert.deepEqual(
    leadFields({
      id: 42,
      uuid: "u",
      email: "jane@example.com",
      first_name: "Jane",
      last_name: "Doe",
      company: "Doe Realty",
      title: "Broker",
      custom_variables: [{ name: "LicenseNumber", value: "104" }, { name: "City", value: "NYC" }],
    }),
    {
      full_name: "Jane Doe",
      email: "jane@example.com",
      company: "Doe Realty",
      title: "Broker",
      custom_fields: { LicenseNumber: "104", City: "NYC" },
    },
  );
  const bare = leadFields({ id: 1, uuid: "u", email: "x@y.z" });
  assert.equal(bare.full_name, null);
  assert.deepEqual(bare.custom_fields, {});
});

test("the inbound reply row", () => {
  const reply: EmailBisonReply = {
    id: 99,
    email_subject: "Re: Hello",
    html_body: "<p>Yes</p>",
    text_body: "Yes",
    from_name: "  Jane Doe  ",
    from_email_address: "jane@example.com",
    primary_to_email_address: "nicole@brokerstaffer.com",
    to: ["nicole@brokerstaffer.com", "colleague@brokerstaffer.com"],
    cc: "boss@example.com",
    date_received: "2026-09-15T14:03:00.000Z",
  };
  const row = inboundFromReply(reply, "jane@example.com");
  assert.deepEqual(row, {
    direction: "inbound",
    externalMessageId: "eb:reply:99",
    sender: "jane@example.com",
    sender_name: "Jane Doe",
    recipients: {
      to: ["nicole@brokerstaffer.com", "colleague@brokerstaffer.com"],
      cc: ["boss@example.com"],
      bcc: [],
    },
    subject: "Re: Hello",
    body_html: "<p>Yes</p>",
    body_text: "Yes",
    sent_at: "2026-09-15T14:03:00.000Z",
    emailbison_reply_id: "99",
  });
});

test("sender falls back to the lead's canonical address, then from_name — never null when either exists", () => {
  assert.equal(inboundFromReply({ id: 1 }, "jane@example.com").sender, "jane@example.com");
  assert.equal(inboundFromReply({ id: 1, from_name: "Jane" }, null).sender, "Jane");
  assert.equal(inboundFromReply({ id: 1 }, null).sender, null);
});

test("to: structured list first, primary_to as the fallback", () => {
  assert.deepEqual(inboundFromReply({ id: 1, primary_to_email_address: "n@b.com" }).recipients.to, ["n@b.com"]);
  assert.deepEqual(inboundFromReply({ id: 1, to: [], primary_to_email_address: "n@b.com" }).recipients.to, ["n@b.com"]);
  assert.deepEqual(inboundFromReply({ id: 1 }).recipients.to, []);
});
