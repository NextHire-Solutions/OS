/*
 * The Add / Edit client form.
 *
 * Three rules here are the sort that get "simplified" by a later reader and
 * then quietly misbehave for months:
 *
 *   the weekly target follows the plan only while it is still a default;
 *   the custom-interval field stays free text until save;
 *   campaigns are matched by name in the BROWSER, because the tool's own
 *   POST /api/clients stores the ids it is given and matches nothing.
 *
 *   node --test src/lib/tools/client-health/clientForm.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  blankForm,
  deleteConfirmText,
  formForClient,
  linkPreviewCount,
  linkPreviewText,
  optimisticClient,
  parseIntervalDays,
  todayLocalISO,
  toPayload,
  withPlan,
  type NamedCampaign,
} from "./clientForm.ts";
import { PLAN_DEFAULT_TARGET, type DashboardClient } from "./types.ts";

const TODAY = "2026-09-11";

const CAMPAIGNS: NamedCampaign[] = [
  { id: "i1", name: "Premier Metro Realty — Q3 Agents" },
  { id: "i2", name: "premier metro realty (retarget)" },
  { id: "i3", name: "Something Else Entirely" },
];
const BISON: NamedCampaign[] = [{ id: "b1", name: "Premier Metro Realty · Bison" }];

// -- plan and target ---------------------------------------------------------

test("a fresh form defaults to Production and its target", () => {
  const f = blankForm(TODAY);
  assert.equal(f.plan, "production");
  assert.equal(f.weeklyTarget, PLAN_DEFAULT_TARGET.production);
  assert.equal(f.startDate, TODAY);
  assert.equal(f.editingId, null);
});

test("changing plan moves an untouched target to the new default", () => {
  const f = withPlan(blankForm(TODAY), "partner");
  assert.equal(f.weeklyTarget, PLAN_DEFAULT_TARGET.partner);
});

test("changing plan leaves a hand-typed target alone", () => {
  // A form that overwrites what you typed is a form that fights you.
  const typed = { ...blankForm(TODAY), weeklyTarget: 4 };
  assert.equal(withPlan(typed, "partner").weeklyTarget, 4);
});

test("a target that happens to equal another plan's default still follows", () => {
  // The tool's own test for "untouched" — imperfect, and reproduced exactly so
  // this port cannot behave differently from the live app.
  const atMinimumDefault = { ...blankForm(TODAY), weeklyTarget: PLAN_DEFAULT_TARGET.minimum };
  assert.equal(withPlan(atMinimumDefault, "partner").weeklyTarget, PLAN_DEFAULT_TARGET.partner);
});

// -- the custom billing interval --------------------------------------------

test("the custom interval parses only for the custom option", () => {
  const base = blankForm(TODAY);
  assert.equal(parseIntervalDays({ ...base, billingInterval: "monthly", billingIntervalDays: "21" }), null);
  assert.equal(parseIntervalDays({ ...base, billingInterval: "custom", billingIntervalDays: "21" }), 21);
});

test("an unparseable or non-positive interval is null, not a guess", () => {
  const base = { ...blankForm(TODAY), billingInterval: "custom" as const };
  for (const raw of ["", "  ", "abc", "0", "-7"]) {
    assert.equal(parseIntervalDays({ ...base, billingIntervalDays: raw }), null, `"${raw}"`);
  }
});

test("a partly typed interval is kept as text, so 21 is reachable", () => {
  // Parsing on every keystroke would snap "2" to 2 and never let you get to 21.
  const base = { ...blankForm(TODAY), billingInterval: "custom" as const, billingIntervalDays: "2" };
  assert.equal(base.billingIntervalDays, "2");
  assert.equal(parseIntervalDays({ ...base, billingIntervalDays: "21" }), 21);
});

// -- auto-linking ------------------------------------------------------------

test("saving links every campaign whose name contains the client name", () => {
  const f = { ...blankForm(TODAY), name: "Premier Metro Realty" };
  const p = toPayload(f, CAMPAIGNS, BISON);

  assert.deepEqual(p.instantly_campaign_ids, ["i1", "i2"], "case and punctuation are normalised");
  assert.deepEqual(p.bison_campaign_ids, ["b1"]);
});

test("the link preview counts both sources and matches what saving does", () => {
  const count = linkPreviewCount("Premier Metro Realty", CAMPAIGNS, BISON);
  const p = toPayload({ ...blankForm(TODAY), name: "Premier Metro Realty" }, CAMPAIGNS, BISON);
  assert.equal(count, 3);
  assert.equal(count, p.instantly_campaign_ids.length + p.bison_campaign_ids.length);
});

test("the preview says something useful in all three states", () => {
  assert.match(linkPreviewText("", 0), /auto-linked on save/);
  assert.match(linkPreviewText("Nobody", 0), /No campaign contains .Nobody./);
  assert.match(linkPreviewText("Premier", 1), /auto-link 1 matching campaign\./);
  assert.match(linkPreviewText("Premier", 3), /auto-link 3 matching campaigns\./);
});

test("a whitespace-only name links nothing", () => {
  assert.equal(linkPreviewCount("   ", CAMPAIGNS, BISON), 0);
});

// -- the payload -------------------------------------------------------------

test("the payload trims the name and nulls every empty date", () => {
  const p = toPayload(
    { ...blankForm(TODAY), name: "  Acme  ", startDate: "", billingAnchorDate: "", timeZone: "" },
    [],
    [],
  );
  assert.equal(p.name, "Acme");
  assert.equal(p.start_date, null);
  assert.equal(p.billing_anchor_date, null);
  assert.equal(p.time_zone, null);
});

test("aliases are NEVER written back from this tool — one editor only", () => {
  const p = toPayload(
    { ...blankForm(TODAY), name: "Acme", aliases: ["Acme Group", "ACME"] },
    [],
    [],
  ) as unknown as Record<string, unknown>;
  // §7 wants one place to edit a field. Aliases are shown here because §8 lists
  // them in this view, but the client record in the OS writes all three stores
  // together; a second writer is how the three copies drifted apart.
  assert.equal("aliases" in p, false);
  assert.equal("campaign_aliases" in p, false);
});

test("the payload carries every field the tool's API accepts", () => {
  const p = toPayload(
    {
      editingId: "x", name: "Acme", plan: "partner", startDate: "2026-01-05",
      weeklyTarget: 6, monthlyTarget: 24, billingAnchorDate: "2026-01-12",
      billingInterval: "custom", billingIntervalDays: "21", timeZone: "America/Denver",
      // Read-only in the form and deliberately NOT in the payload — the OS is
      // the single editor of aliases. The assertion below pins that.
      aliases: ["Acme Group"],
    },
    [],
    [],
  );

  assert.deepEqual(p, {
    name: "Acme",
    plan: "partner",
    weekly_target: 6,
    monthly_target: 24,
    start_date: "2026-01-05",
    instantly_campaign_ids: [],
    bison_campaign_ids: [],
    billing_anchor_date: "2026-01-12",
    billing_interval: "custom",
    billing_interval_days: 21,
    time_zone: "America/Denver",
  });
});

// -- editing an existing client ---------------------------------------------

test("editing fills the form from the client, and round-trips", () => {
  const c = {
    id: "abc", name: "Keyes", plan: "minimum", start_date: "2025-04-01",
    weekly_target: 1, monthly_target: 4, billing_anchor_date: "2025-04-15",
    billing_interval: "custom", billing_interval_days: 30, time_zone: "America/New_York",
  } as DashboardClient;

  const f = formForClient(c);
  assert.equal(f.editingId, "abc");
  assert.equal(f.billingIntervalDays, "30", "the number becomes text for the input");

  const p = toPayload(f, [], []);
  assert.equal(p.billing_interval_days, 30);
  assert.equal(p.time_zone, "America/New_York");
});

test("a client with nothing set produces empty strings, not the word null", () => {
  const c = {
    id: "abc", name: "New", plan: "production", start_date: null, weekly_target: 3,
    monthly_target: 0, billing_anchor_date: null, billing_interval: "biweekly",
    billing_interval_days: null, time_zone: null,
  } as DashboardClient;

  const f = formForClient(c);
  assert.equal(f.startDate, "");
  assert.equal(f.billingAnchorDate, "");
  assert.equal(f.billingIntervalDays, "");
  assert.equal(f.timeZone, "");
});

// -- deleting ----------------------------------------------------------------

test("the delete confirmation names the client and the cascade", () => {
  const linked = { name: "Keyes", instantly_campaign_ids: ["a"], bison_campaign_ids: ["b", "c"] } as DashboardClient;
  const text = deleteConfirmText(linked);
  assert.match(text, /Keyes/);
  assert.match(text, /3 linked campaign cache rows/);

  const bare = { name: "Solo", instantly_campaign_ids: [], bison_campaign_ids: [] } as unknown as DashboardClient;
  assert.match(deleteConfirmText(bare), /Remove Solo\?/);
  assert.doesNotMatch(deleteConfirmText(bare), /campaign cache/);
});

test("one linked campaign is singular", () => {
  const one = { name: "X", instantly_campaign_ids: ["a"], bison_campaign_ids: [] } as unknown as DashboardClient;
  assert.match(deleteConfirmText(one), /1 linked campaign cache row \(/);
});

// -- the optimistic row ------------------------------------------------------

test("a newly added client has every field the table reads", () => {
  // The row renders the instant this returns. A missing field is a crash on
  // the one client somebody is definitely looking at.
  const c = optimisticClient("new-id", toPayload({ ...blankForm(TODAY), name: "Acme" }, [], []));

  for (const field of [
    "id", "name", "plan", "weekly_target", "monthly_target", "start_date",
    "campaign_size", "hidden", "client_paused", "portal_active", "emails_today",
    "emails_today_date", "portal_synced_at", "time_zone", "dnc_count", "agents_count",
    "last_lead_activity_at", "stagnant_intros_count", "intros_since_last_billing",
    "intros_this_month", "portal_url", "total_intros_corofy", "total_interested_corofy",
    "campaigns", "bisonCampaigns", "metricsByWeek", "portalActive",
    "billing_anchor_date", "billing_interval", "billing_interval_days",
    "instantly_campaign_ids", "bison_campaign_ids",
  ]) {
    assert.ok(field in c, `optimisticClient is missing ${field}`);
  }

  assert.equal(c.id, "new-id");
  assert.deepEqual(c.metricsByWeek, {});
  assert.equal(c.hidden, false);
});

// -- today -------------------------------------------------------------------

test("today is the LOCAL calendar date, not the UTC one", () => {
  // 01:30 in Delhi on the 11th is still the 10th in UTC. toISOString() would
  // open the form on yesterday for every user east of London.
  const earlyMorningIST = new Date("2026-09-10T20:00:00Z");
  const local = todayLocalISO(earlyMorningIST);
  const expected = [
    earlyMorningIST.getFullYear(),
    String(earlyMorningIST.getMonth() + 1).padStart(2, "0"),
    String(earlyMorningIST.getDate()).padStart(2, "0"),
  ].join("-");

  assert.equal(local, expected);
  assert.match(local, /^\d{4}-\d{2}-\d{2}$/);
});
