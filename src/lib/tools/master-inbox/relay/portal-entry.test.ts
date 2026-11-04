/*
 * The hand-off's Pipeline entry must be the row the Introduction label's trigger makes (Master Inbox 0073). The SQL's own
 * coalesce order, case by case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { pipelineEntryRow } from "./portal-entry.ts";

const base = { portalId: "p", threadId: "t", leadId: "l", agentName: "Hand-off Name", agentEmail: "handoff@x.test", at: "2026-11-04T00:00:00.000Z" };
const row = (lead: Parameters<typeof pipelineEntryRow>[0]["lead"]) => pipelineEntryRow({ ...base, lead });

test("the first stage, the portal, the conversation, the lead, and when", () => {
  const r = row({ full_name: "Jo", email: "jo@x.test", custom_fields: {} });
  assert.deepEqual([r.client_id, r.thread_id, r.lead_id, r.stage, r.introduced_at], ["p", "t", "l", "introduction", base.at]);
  assert.ok(!("source" in r), "the column's own default: BrokerStaffer, as the trigger leaves it");
  assert.ok(!("custom_stage_key" in r));
});

test("email: the staff-chosen one, else the lead's", () => {
  assert.equal(row({ email: "jo@x.test", custom_fields: { preferred_email: "chosen@x.test" } }).lead_email, "chosen@x.test");
  assert.equal(row({ email: "jo@x.test", custom_fields: {} }).lead_email, "jo@x.test");
  assert.equal(row({ email: "jo@x.test" }).lead_email, "jo@x.test");
});

test("phone: preferred_phone, then phone, then Phone", () => {
  assert.equal(row({ custom_fields: { preferred_phone: "1", phone: "2", Phone: "3" } }).lead_phone, "1");
  assert.equal(row({ custom_fields: { phone: "2", Phone: "3" } }).lead_phone, "2");
  assert.equal(row({ custom_fields: { Phone: "3" } }).lead_phone, "3");
  assert.equal(row({ custom_fields: {} }).lead_phone, null);
});

test("what EmailBison's leads really hold: the number under 'phone number', the brokerage on the lead (John Kaye's and Ram Ethirajan's shape), so the Pipeline shows what the Slack alert showed", () => {
  const r = row({ full_name: "John Kaye", email: "john@x.test", company: "Investment Realty Homes & Loan", custom_fields: { "phone number": "+16193234439", "subject phone": "(619) 323-4439", "office city": "Chula Vista, CA" } });
  assert.deepEqual([r.lead_phone, r.current_brokerage], ["+16193234439", "Investment Realty Homes & Loan"]);
  assert.equal(row({ custom_fields: { phone_number: "2" } }).lead_phone, "2");
  assert.equal(row({ custom_fields: { mobile: "3" } }).lead_phone, "3");
  assert.equal(row({ custom_fields: { phone: "1", "phone number": "2" } }).lead_phone, "1", "the trigger's own field still wins");
  assert.equal(row({ company: "On the lead", custom_fields: { company: "In the fields" } }).current_brokerage, "In the fields");
  assert.equal(row({ custom_fields: {} }).current_brokerage, null);
  assert.equal(row({ custom_fields: { phone: "", "phone number": "2" } }).lead_phone, "2", "an empty field doesn't hide the real number");
  assert.equal(row({ company: "On the lead", custom_fields: { company: "" } }).current_brokerage, "On the lead");
});

test("brokerage: companyName, then company; profile: Agent Profile, agentProfile, website", () => {
  assert.equal(row({ custom_fields: { companyName: "A", company: "B" } }).current_brokerage, "A");
  assert.equal(row({ custom_fields: { company: "B" } }).current_brokerage, "B");
  assert.equal(row({ custom_fields: { "Agent Profile": "1", agentProfile: "2", website: "3" } }).agent_profile_url, "1");
  assert.equal(row({ custom_fields: { agentProfile: "2", website: "3" } }).agent_profile_url, "2");
  assert.equal(row({ custom_fields: { website: "3" } }).agent_profile_url, "3");
});

test("as Postgres's ->> and coalesce: an empty string counts as a value, a JSON null doesn't, a number is text", () => {
  assert.equal(row({ email: "jo@x.test", custom_fields: { preferred_email: "" } }).lead_email, "");
  assert.equal(row({ email: "jo@x.test", custom_fields: { preferred_email: null } }).lead_email, "jo@x.test");
  assert.equal(row({ custom_fields: { phone: 5551234 } }).lead_phone, "5551234");
});

test("no lead to read: the hand-off's own name and address, so the entry is never a blank row", () => {
  const r = row(null);
  assert.deepEqual([r.lead_name, r.lead_email, r.lead_phone], ["Hand-off Name", "handoff@x.test", null]);
});
