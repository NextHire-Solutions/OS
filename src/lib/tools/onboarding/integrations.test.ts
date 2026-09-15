/*
 * The pure parts of Onboarding's integrations — every rule that decides what
 * leaves the building, tested with nothing leaving it.
 *
 *   node --import ./scripts/alias-hooks.mjs --test src/lib/tools/onboarding/integrations.test.ts
 *
 * Only modules with no server imports are here; the fetches live behind them in
 * `server-only` files. Where a builder needs a "has this happened?" lookup it is
 * passed in, so the guards can be driven both ways.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { intakeQA, referralSalesperson, teamFromIntake, toClientRow, verifySignature } from "./typeform.ts";
import { TYPEFORM_FIELD_MAP } from "./typeform-field-map.ts";
import { decodeEntities, esc, intakeHeadText, intakeThreadChunks, mentionFrom } from "./slack-format.ts";
import { bearerAccepted, queryTokenAccepted } from "./webhook-auth.ts";
import { isPaidSession, modeOfKey, pickStripeKey } from "./stripe-pure.ts";
import { followupDue } from "./followup-pure.ts";
import { flippedCampaignIds } from "./db-sync-pure.ts";
import { cancelNeedsPing } from "./booking-alerts-pure.ts";
import { calendlyDecision } from "./calendly-pure.ts";
import { buildConsentUrl, isInvalidGrant, shouldAlert, REALERT_MS } from "./gmail-pure.ts";
import { buildFilters, mapBisonFields, withoutDnc } from "./lead-filters.ts";
import {
  bisonSequenceSteps, buildAlias, campaignName, compact, healthDashBody, introPerson, isoWeekStart,
  portalOnboardBody, scheduleIdFor, teamLanes, toBisonBody,
} from "./connector-payloads.ts";
import { isRefusedStep, stepPrecondition } from "./step-preconditions.ts";
import { RUNNABLE_KEYS } from "./step-effects.ts";

/* -------------------------------- typeform -------------------------------- */

const M = TYPEFORM_FIELD_MAP;
const answer = (ref: string, type: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  type, field: { ref, id: `id-${ref}`, ...extra }, [type]: value,
});

const PAYLOAD = {
  form_response: {
    token: "tok-1",
    definition: {
      fields: [
        { id: `id-${M["_team.intro_contacts"][0]}`, ref: M["_team.intro_contacts"][0], title: "Who should we introduce candidates to?" },
        { id: `id-${M["_team.intro_titles"][0]}`, ref: M["_team.intro_titles"][0], title: "What title should we use?" },
        { id: `id-${M._dnc_exclude_list}`, ref: M._dnc_exclude_list, title: "List the names of the offices or agents to exclude" },
      ],
    },
    answers: [
      answer(M["client.client_name"], "text", "Rise Realty"),
      answer(M["client.primary_contact.name"], "text", "Dana Smith"),
      answer(M["client.primary_contact.email"], "email", "dana@rise.com"),
      answer(M["client.mls"], "choice", { label: "Bright MLS (BRIGHT)" }),
      answer(M["client.location"], "text", "Austin, TX"),
      answer(M._sales_volume_choice, "choice", { label: "$5M to $10M" }),
      answer(M._referral, "text", "Ryan"),
      answer(M["_team.intro_contacts"][0], "text", "Sam Jones sam@rise.com"),
      answer(M["_team.intro_titles"][0], "text", "Broker Owner"),
      answer(M._dnc_exclude_list, "long_text", "Keller Williams Realty, Inc.\nJohn Smith, Jane Doe"),
    ],
  },
};

test("Typeform-Signature is verified in constant time over the raw body", () => {
  const raw = JSON.stringify(PAYLOAD);
  const good = "sha256=" + createHmac("sha256", "s3cret").update(raw).digest("base64");
  assert.equal(verifySignature(raw, good, "s3cret"), true);
  assert.equal(verifySignature(raw, good, "other"), false);
  assert.equal(verifySignature(raw + " ", good, "s3cret"), false);
  assert.equal(verifySignature(raw, null, "s3cret"), false);
  assert.equal(verifySignature(raw, "sha256=short", "s3cret"), false);
});

test("a submission becomes the tool's client row: MLS code, brand doubles as office, volume bucket", () => {
  const row = toClientRow(PAYLOAD as never);
  assert.equal(row.typeform_response_id, "tok-1");
  assert.equal(row.status, "new");
  assert.equal(row.client_name, "Rise Realty");
  assert.equal(row.brand, "Rise Realty");
  assert.equal(row.office_name, "Rise Realty");
  assert.equal(row.mls, "BRIGHT");
  assert.deepEqual(row.primary_contact, { name: "Dana Smith", email: "dana@rise.com", phone: null, role: null });
  assert.deepEqual(row.filters, {
    sales_volume_min: 5_000_000, sales_volume_max: 10_000_000, closed_transactions_min: 0, closed_transactions_max: 5,
  });
  assert.equal(row.raw_typeform, PAYLOAD);
});

test("an unanswered volume bucket falls back to the spec default", () => {
  const row = toClientRow({ form_response: { answers: [] } });
  assert.deepEqual(row.filters, { sales_volume_min: 0, sales_volume_max: 5_000_000, closed_transactions_min: 0, closed_transactions_max: 5 });
  assert.equal(row.client_name, null);
});

test("the referral salesperson is read, but 'I did it myself' is nobody", () => {
  assert.equal(referralSalesperson(PAYLOAD as never), "Ryan");
  const solo = { form_response: { answers: [answer(M._referral, "text", "I did it myself")] } };
  assert.equal(referralSalesperson(solo), null);
});

test("intake people: intro contact with title, DNC lines kept whole and split on commas", () => {
  const people = teamFromIntake(PAYLOAD as never);
  assert.deepEqual(people[0], { name: "Sam Jones", email: "sam@rise.com", role: "Broker Owner", is_dnc: false });
  const dnc = people.filter((p) => p.is_dnc).map((p) => p.name);
  // A comma line is kept WHOLE (offices must exact-match) and its multi-word
  // parts are added too ("Inc." has no space, so it is not a name on its own).
  assert.deepEqual(dnc, ["Keller Williams Realty, Inc.", "Keller Williams Realty", "John Smith, Jane Doe", "John Smith", "Jane Doe"]);
});

test("the Q&A carries the form's own question titles, in order", () => {
  const qa = intakeQA(PAYLOAD as never);
  assert.equal(qa[7].q, "Who should we introduce candidates to?");
  assert.equal(qa[7].a, "Sam Jones sam@rise.com");
  assert.equal(qa[3].a, "Bright MLS (BRIGHT)");
  assert.equal(qa[0].q, "Question"); // no title in the definition, not a contact field
});

/* ---------------------------------- slack --------------------------------- */

test("external text is escaped so a subject cannot smuggle in a channel mention", () => {
  assert.equal(esc("<!channel> & co"), "&lt;!channel&gt; &amp; co");
  assert.equal(intakeHeadText("A <b>"), ":tada: New client onboarded — *A &lt;b&gt;*\n_Full intake answers in the thread_ :thread:");
});

test("the intake thread is chunked under Slack's limit without splitting an item", () => {
  const qa = Array.from({ length: 40 }, (_, i) => ({ q: `Question ${i}`, a: "x".repeat(200) }));
  const chunks = intakeThreadChunks(qa, 1000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1000 + 220, "one item may push a chunk over only by itself");
  assert.ok(chunks[0].startsWith("*1. Question 0*\n> "));
  assert.equal(intakeThreadChunks([]).length, 0);
});

test("the mention defaults to <!here> and an explicit empty string disables it", () => {
  assert.equal(mentionFrom(undefined), "<!here>");
  assert.equal(mentionFrom(""), "");
  assert.equal(mentionFrom("<!channel>"), "<!channel>");
});

test("Gmail snippets are entity-decoded before display", () => {
  assert.equal(decodeEntities("it&#39;s &quot;fine&quot; &amp; &lt;ok&gt;"), `it's "fine" & <ok>`);
});

/* ---------------------------------- auth ---------------------------------- */

test("webhook query tokens: skipped while unset, exact match otherwise", () => {
  assert.equal(queryTokenAccepted("https://x/y", undefined), true);
  assert.equal(queryTokenAccepted("https://x/y?token=abc", "abc"), true);
  assert.equal(queryTokenAccepted("https://x/y?token=abd", "abc"), false);
  assert.equal(queryTokenAccepted("https://x/y", "abc"), false);
});

test("cron bearer: fails closed when unset, and only the exact secret passes", () => {
  assert.equal(bearerAccepted("Bearer s", undefined), "unconfigured");
  assert.equal(bearerAccepted("Bearer s", "s"), "ok");
  assert.equal(bearerAccepted("bearer  s ", "s"), "ok");
  assert.equal(bearerAccepted("Bearer t", "s"), "denied");
  assert.equal(bearerAccepted(null, "s"), "denied");
  assert.equal(bearerAccepted("s", "s"), "denied");
});

/* --------------------------------- stripe --------------------------------- */

test("the Stripe key rule: test mode picks the test key, anything else the live one", () => {
  assert.equal(pickStripeKey({ mode: "test", live: "sk_live_1", test: "sk_test_1" }), "sk_test_1");
  assert.equal(pickStripeKey({ mode: "live", live: "sk_live_1", test: "sk_test_1" }), "sk_live_1");
  assert.equal(pickStripeKey({ live: "sk_live_1", test: "sk_test_1" }), "sk_live_1");
  assert.equal(pickStripeKey({ mode: "test", live: "sk_live_1" }), "sk_live_1");
  assert.equal(pickStripeKey({}), null);
  assert.equal(modeOfKey("sk_test_x"), "test");
  assert.equal(modeOfKey("rk_live_x"), "live");
  assert.equal(modeOfKey("pk_live_x"), "unknown");
});

test("a webhook counts only when the re-fetched session is actually paid", () => {
  assert.equal(isPaidSession({ payment_status: "paid" }), true);
  assert.equal(isPaidSession({ status: "complete" }), true);
  assert.equal(isPaidSession({ payment_status: "unpaid", status: "open" }), false);
  assert.equal(isPaidSession(null), false);
});

/* -------------------------------- follow-up ------------------------------- */

test("the follow-up is due 21 days after the call, or after intake when no call was booked", () => {
  const day = 24 * 3600_000;
  const now = Date.parse("2026-09-15T12:00:00Z");
  const contact = { primary_contact: { email: "a@b.c" } };
  assert.equal(followupDue({ ...contact, onboarding_date: new Date(now - 22 * day).toISOString(), created_at: "" }, now, 21), true);
  assert.equal(followupDue({ ...contact, onboarding_date: new Date(now - 20 * day).toISOString(), created_at: "" }, now, 21), false);
  assert.equal(followupDue({ ...contact, onboarding_date: null, created_at: new Date(now - 30 * day).toISOString() }, now, 21), true);
  assert.equal(followupDue({ primary_contact: null, onboarding_date: null, created_at: new Date(now - 30 * day).toISOString() }, now, 21), false);
  assert.equal(followupDue({ ...contact, onboarding_date: "garbage", created_at: "" }, now, 21), false);
});

/* --------------------------------- db-sync -------------------------------- */

test("the DB app's flip is matched on every identifier the row carries", () => {
  const set = flippedCampaignIds([
    { bison_campaign_id: "uuid-1", raw: { id: 42, uuid: "uuid-1" } },
    { bison_campaign_id: null, raw: null },
  ]);
  assert.deepEqual([...set].sort(), ["42", "uuid-1"]);
});

/* ----------------------------- booking alerts ----------------------------- */

test("a cancelled call pings once, and never before there was a booking", () => {
  assert.equal(cancelNeedsPing([]), false);
  assert.equal(cancelNeedsPing([{ action: "onboarding_call_canceled", created_at: "2026-09-10" }]), true);
  assert.equal(cancelNeedsPing([
    { action: "booking_cancel_ping", created_at: "2026-09-11" },
    { action: "onboarding_call_canceled", created_at: "2026-09-10" },
  ]), false);
  assert.equal(cancelNeedsPing([
    { action: "onboarding_call_canceled", created_at: "2026-09-12" },
    { action: "booking_cancel_ping", created_at: "2026-09-11" },
    { action: "onboarding_call_canceled", created_at: "2026-09-10" },
  ]), true);
});

/* -------------------------------- calendly -------------------------------- */

test("only the setup-call event type touches onboarding_date", () => {
  const body = (event: string, type: string) => ({
    event, payload: { email: " dana@rise.com ", scheduled_event: { event_type: type, start_time: "2026-10-01T15:00:00Z", name: "Setup" } },
  });
  assert.deepEqual(calendlyDecision(body("invitee.created", "https://api.calendly.com/event_types/setup"), "https://api.calendly.com/event_types/setup"),
    { event: "invitee.created", email: "dana@rise.com", startTime: "2026-10-01T15:00:00Z", eventName: "Setup" });
  assert.deepEqual(calendlyDecision(body("invitee.created", "other"), "setup"), { ignored: "other event type" });
  const cancel = calendlyDecision(body("invitee.canceled", "setup"), undefined);
  assert.equal("event" in cancel ? cancel.event : null, "invitee.canceled");
  assert.deepEqual(calendlyDecision({ event: "routing_form_submission.created" }, undefined), { ignored: "routing_form_submission.created" });
  assert.deepEqual(calendlyDecision({ event: "invitee.created", payload: {} }, undefined), { ignored: "no invitee email" });
});

/* ---------------------------------- gmail --------------------------------- */

test("the consent URL asks for offline access and a fresh refresh token", () => {
  const u = new URL(buildConsentUrl("cid", "https://os.brokerstaffer.com/api/tools/onboarding/auth/google/callback", "connect"));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("redirect_uri"), "https://os.brokerstaffer.com/api/tools/onboarding/auth/google/callback");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.match(u.searchParams.get("scope") ?? "", /gmail\.modify/);
});

test("the broken-mailbox alert fires on the first break, then daily", () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(shouldAlert(undefined, now), { alert: true, stale: false });
  assert.deepEqual(shouldAlert({ ok: true, lastAlertAt: 0 }, now), { alert: true, stale: false });
  assert.deepEqual(shouldAlert({ ok: false, lastAlertAt: now - 3600_000 }, now), { alert: false, stale: false });
  assert.deepEqual(shouldAlert({ ok: false, lastAlertAt: now - REALERT_MS - 1 }, now), { alert: true, stale: true });
  assert.equal(isInvalidGrant("token endpoint 400: {\"error\":\"invalid_grant\"}"), true);
  assert.equal(isInvalidGrant("ECONNRESET"), false);
});

/* ------------------------------ lead filters ------------------------------ */

test("the lead filter excludes the client's own brand and office, managers, and scopes by city", () => {
  const f = buildFilters({
    mlsIds: ["m1"], location: "Austin (South), TX", salesVolumeMin: 0, salesVolumeMax: 5_000_000,
    excludeBrands: ["Rise", "Real Brokerage Technologies"], excludeOffices: ["Rise Realty"], excludeTitles: ["Team Leader", "Managing Broker"],
  }) as Record<string, Record<string, unknown>>;
  assert.deepEqual(f.mls, { include: ["m1"], exclude: [] });
  assert.deepEqual(f.salesVolume, { side: "all", buckets: [], min: "0", max: "5000000" });
  assert.deepEqual(f.officeSearch, { brand: { include: [], exclude: ["Rise", "Real Brokerage Technologies"] }, office: { include: [], exclude: ["Rise Realty"] } });
  assert.deepEqual(f.title, { include: [], exclude: ["Team Leader", "Managing Broker"] });
  assert.deepEqual(f.location, { field: "city", appliesTo: ["office", "transacted"], values: ["Austin  South"] });
  assert.equal("location" in buildFilters({ mlsIds: [] }), false);
});

test("Bison fields come from the RPC row, with the MLS list joined", () => {
  const d = mapBisonFields({ preferred_email: "a@b.c", first_name: "A", last_name: "B", mls: [{ code: "X" }, { code: "Y" }] });
  assert.equal(d.final_email, "a@b.c");
  assert.equal(d.mls_affiliation, "X | Y");
  assert.equal(mapBisonFields({}, "FALLBACK").mls_affiliation, "FALLBACK");
});

test("DNC drops a lead by person name OR office name, case-insensitively", () => {
  const leads = [
    { agent_id: "1", data: { first_name: "John", last_name: "Smith", office_name: "Acme" } },
    { agent_id: "2", data: { first_name: "Jane", last_name: "Doe", office_name: "Keller Williams Realty, Inc." } },
    { agent_id: "3", data: { first_name: "Sam", last_name: "Lee", office_name: "Other" } },
  ];
  assert.deepEqual(withoutDnc(leads, ["john  smith", "keller williams realty, inc."]).map((l) => l.agent_id), ["3"]);
  assert.equal(withoutDnc(leads, []).length, 3);
});

/* ---------------------------- connector payloads -------------------------- */

const CLIENT = {
  id: "c1", client_name: "Rise Realty", mls: "BRIGHT", location: "Austin, TX", timezone: "cst",
  plan: null, weekly_target: null, created_at: "2026-09-01T10:00:00Z",
  primary_contact: { name: "Dana Smith", email: "dana@rise.com" }, salespeople: { name: "Ryan" },
};

test("the portal body: alias, and the intro macro falls back to the named intro contact's role", () => {
  const body = portalOnboardBody(CLIENT, [{ name: "Sam Jones", email: null, role: "Broker Owner", is_dnc: false }]);
  assert.equal(buildAlias(CLIENT), "Rise Realty + Ryan + BRIGHT");
  assert.deepEqual(body, {
    name: "Rise Realty", aliases: ["Rise Realty + Ryan + BRIGHT"],
    intro_macro: { brokerage: "Rise Realty", client_full_name: "Sam Jones", client_first_name: "Sam", client_role: "Broker Owner" },
  });
  // The contact's own role wins when the form asked for it; "Team Leader" when nobody has one.
  assert.deepEqual(introPerson({ name: "Dana Smith", role: "CEO" }, []), { name: "Dana Smith", role: "CEO" });
  assert.deepEqual(introPerson({ name: "Dana Smith" }, []), { name: "Dana Smith", role: "Team Leader" });
});

test("team lanes: intake contacts to /team, the scraped roster to /agents, exclusions to /dnc; blanks omitted", () => {
  const rows = [
    { name: "Sam", email: "s@x", phone: null, role: null, source: "typeform", is_dnc: false },
    { name: "Ex", email: null, phone: null, role: "DNC (from intake)", source: "typeform", is_dnc: true },
    { name: "Ag", email: "a@x", phone: "1", role: "Agent", source: "db", is_dnc: true },
  ];
  const l = teamLanes(rows);
  assert.deepEqual(l.teamContacts.map((m) => m.name), ["Sam"]);
  assert.deepEqual(l.external.map((m) => m.name), ["Ex"]);
  assert.deepEqual(l.roster.map((m) => m.name), ["Ag"]);
  assert.deepEqual(compact({ name: "Sam", email: null, title: "Team Member", phone: undefined }), { name: "Sam", title: "Team Member" });
});

test("the Health Dash body uses the tool's defaults and the intake date", () => {
  assert.deepEqual(healthDashBody(CLIENT), { name: "Rise Realty", plan: "production", weekly_target: 3, start_date: "2026-09-01" });
  assert.deepEqual(healthDashBody({ ...CLIENT, plan: "partner", weekly_target: 5, created_at: null }), { name: "Rise Realty", plan: "partner", weekly_target: 5 });
});

test("the Bison campaign: Nicole is the sender, the schedule follows the timezone, S2/S3 thread-reply", () => {
  assert.equal(campaignName(CLIENT), "Rise Realty + Nicole + BRIGHT");
  assert.equal(scheduleIdFor("cst"), 15);
  assert.equal(scheduleIdFor(null), 2);
  assert.equal(scheduleIdFor("nowhere"), 2);
  assert.equal(toBisonBody("Hi {{First Name}} from {{Brokerage Name}}", { brokerageName: "Rise" }), "Hi {FIRST_NAME} from Rise");
  const steps = bisonSequenceSteps([
    { subject: "Hello {{firstName}}", body: "S1 {{brokerage}}", sort: 1 },
    { subject: null, body: "S2", sort: 2 },
    { subject: null, body: "S3", sort: 3 },
    { subject: null, body: "S4", sort: 4 },
  ], "fallback", { brokerage: "Rise" });
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0], { order: 1, email_subject: "Hello {FIRST_NAME}", email_subject_variables: ["{FIRST_NAME}"], email_body: "S1 Rise", wait_in_days: 1, variant: false, thread_reply: false });
  assert.equal(steps[1].thread_reply, true);
  assert.equal(steps[1].wait_in_days, 2);
  assert.equal(steps[2].email_subject, "Hello {FIRST_NAME}");
  assert.equal(bisonSequenceSteps([], "fallback", {}).length, 0);
});

test("the weekly-target window starts on Monday 00:00 UTC", () => {
  assert.equal(isoWeekStart(new Date("2026-09-17T15:30:00Z")).toISOString(), "2026-09-14T00:00:00.000Z"); // Thursday -> Monday
  assert.equal(isoWeekStart(new Date("2026-09-13T01:00:00Z")).toISOString(), "2026-09-07T00:00:00.000Z"); // Sunday -> previous Monday
});

/* ---------------------------- step preconditions -------------------------- */

const never = async () => false;
const always = async () => true;
const base = { id: "c1", primary_contact: { email: "a@b.c" }, client_name: "Rise", mls: "BRIGHT" };

test("every step's precondition is the tool's, and passes on a well-formed client", async () => {
  for (const key of RUNNABLE_KEYS) {
    assert.equal(await stepPrecondition(key, { ...base, bison_campaign_id: key.startsWith("campaign:") && key !== "campaign:build" ? "9" : null, portal_url: key.startsWith("email:") ? "https://p" : null }, never), null, key);
  }
});

test("the guards refuse what the tool refuses", async () => {
  assert.equal(await stepPrecondition("email:welcome", { ...base, primary_contact: null }, never), "this client has no email address on file");
  assert.equal(await stepPrecondition("email:welcome", base, always), "the welcome email has already been sent to this client");
  assert.equal(await stepPrecondition("email:portal", base, never), "this client has no portal yet — create the portal first");
  assert.equal(await stepPrecondition("push:client_portal", { ...base, portal_url: "https://p" }, never), "this client already has a portal");
  assert.equal(await stepPrecondition("push:health_dash", base, always), "this client is already on the Health Dashboard");
  assert.equal(await stepPrecondition("build:team", { ...base, client_name: null }, never), "this client has no firm name to match agents against");
  assert.equal(await stepPrecondition("build:leads", { ...base, mls: null }, never), "this client has no MLS set — pick one before building the list");
  assert.equal(await stepPrecondition("campaign:build", { ...base, bison_campaign_id: "9" }, never), "a campaign already exists for this client (id 9)");
  assert.equal(await stepPrecondition("campaign:launch", base, never), "this client has no campaign yet — create the campaign first");
  assert.equal(await stepPrecondition("campaign:pause", base, never), "this client has no campaign yet — create the campaign first");
  assert.equal(await stepPrecondition("payment:link", { ...base, primary_contact: {} }, never), "this client has no email address on file");
});

test("exactly the seven email steps and the payment link stay switched off", () => {
  const off = RUNNABLE_KEYS.filter(isRefusedStep).sort();
  assert.deepEqual(off, [
    "email:campaign_launched", "email:confirmations", "email:dnc_reminder", "email:followup_call",
    "email:how_intros_work", "email:meet_team", "email:portal", "email:welcome", "payment:link",
  ]);
  for (const k of ["push:client_portal", "push:health_dash", "build:team", "build:leads", "campaign:build", "campaign:launch", "campaign:pause", "setup:remaining"]) {
    assert.equal(isRefusedStep(k), false, k);
  }
});
