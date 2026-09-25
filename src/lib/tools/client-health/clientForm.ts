import { autoMatchCampaignIds } from "./matchCampaigns.ts";
import {
  PLAN_DEFAULT_TARGET,
  type BillingInterval,
  type DashboardClient,
  type Plan,
} from "./types.ts";

/*
 * The Add / Edit client form — its state, and the payload it produces.
 *
 * Out of the component because it is the part with rules in it, and every one
 * of those rules is a decision the tool made that a reimplementation would get
 * differently:
 *
 *   the weekly target follows the plan ONLY while it is still a plan default.
 *   Once somebody types 4, changing plan must not overwrite it — that is the
 *   difference between a helpful default and a form that fights you.
 *
 *   the custom-interval field is free text while you type. Parsing on every
 *   keystroke makes "21" unreachable, because "2" then "1" means the field
 *   snaps to 2 and you cannot get back.
 *
 *   campaigns are auto-linked by NAME, on save, by the browser. The tool's
 *   POST /api/clients does not do this itself — it stores the ids it is
 *   given — so a port that skipped it would create clients linked to nothing
 *   and nobody would see why the row stayed empty.
 */

/** A campaign, reduced to what name-matching needs. */
export interface NamedCampaign {
  id: string;
  name: string;
}

export interface ClientFormState {
  editingId: string | null;
  name: string;
  plan: Plan;
  startDate: string;
  weeklyTarget: number;
  monthlyTarget: number;
  billingAnchorDate: string;
  billingInterval: BillingInterval;
  /** Free text while editing; parsed on save. See the note above. */
  billingIntervalDays: string;
  /** An IANA string from TIME_ZONES, or "" for none. */
  timeZone: string;
  /**
   * The other spellings this client is known by. READ ONLY here.
   *
   * Shown because §8 lists Aliases as a field of this view, and NOT editable
   * because §7 wants one place to edit each field — that place is the client
   * record in the OS, which writes all three alias stores together. `toPayload`
   * maps fields one by one, so this can never be written back from here.
   */
  aliases: string[];
}

/**
 * A blank form.
 *
 * `today` is passed rather than read, so the date the form opens on is the
 * caller's business — and so this is testable. The tool uses the user's LOCAL
 * calendar date, not `toISOString()`, which is a day behind for anyone east of
 * UTC in the early morning.
 */
export function blankForm(today: string): ClientFormState {
  return {
    editingId: null,
    aliases: [],
    name: "",
    plan: "production",
    startDate: today,
    weeklyTarget: PLAN_DEFAULT_TARGET.production,
    monthlyTarget: 0,
    billingAnchorDate: "",
    billingInterval: "biweekly",
    billingIntervalDays: "",
    timeZone: "",
  };
}

/** The user's local calendar date as YYYY-MM-DD. */
export function todayLocalISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The form, filled in from an existing client. */
export function formForClient(c: DashboardClient): ClientFormState {
  return {
    editingId: c.id,
    aliases: c.campaign_aliases ?? [],
    name: c.name,
    plan: c.plan,
    startDate: c.start_date ?? "",
    weeklyTarget: c.weekly_target,
    monthlyTarget: c.monthly_target ?? 0,
    billingAnchorDate: c.billing_anchor_date ?? "",
    billingInterval: c.billing_interval ?? "biweekly",
    billingIntervalDays: c.billing_interval_days != null ? String(c.billing_interval_days) : "",
    timeZone: c.time_zone ?? "",
  };
}

/**
 * Changing the plan, keeping a hand-typed target.
 *
 * The target moves to the new plan's default only if it is currently SOME
 * plan's default — which is the tool's test for "the user has not touched it".
 */
export function withPlan(form: ClientFormState, plan: Plan): ClientFormState {
  const untouched = Object.values(PLAN_DEFAULT_TARGET).includes(form.weeklyTarget);
  return { ...form, plan, weeklyTarget: untouched ? PLAN_DEFAULT_TARGET[plan] : form.weeklyTarget };
}

/**
 * The custom cadence, as an integer.
 *
 * Null for every non-custom interval and for anything unparseable or
 * non-positive — the tool treats that as "no cadence set yet", and its
 * billing-date helper returns null rather than inventing one.
 */
export function parseIntervalDays(form: ClientFormState): number | null {
  if (form.billingInterval !== "custom") return null;
  const parsed = parseInt(form.billingIntervalDays, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export interface ClientPayload {
  name: string;
  plan: Plan;
  weekly_target: number;
  monthly_target: number;
  start_date: string | null;
  instantly_campaign_ids: string[];
  bison_campaign_ids: string[];
  billing_anchor_date: string | null;
  billing_interval: BillingInterval;
  billing_interval_days: number | null;
  time_zone: string | null;
}

/**
 * The body the tool's `/api/clients` expects.
 *
 * Campaigns are matched here, by the same `autoMatchCampaignIds` the tool's
 * seed script and its sync worker's relink step use — so a client added
 * through this form links to exactly what a re-seed would link it to.
 */
export function toPayload(
  form: ClientFormState,
  instantly: readonly NamedCampaign[],
  bison: readonly NamedCampaign[],
): ClientPayload {
  const name = form.name.trim();
  return {
    name,
    plan: form.plan,
    weekly_target: form.weeklyTarget,
    monthly_target: form.monthlyTarget,
    start_date: form.startDate || null,
    instantly_campaign_ids: autoMatchCampaignIds(name, instantly),
    bison_campaign_ids: autoMatchCampaignIds(name, bison),
    billing_anchor_date: form.billingAnchorDate || null,
    billing_interval: form.billingInterval,
    billing_interval_days: parseIntervalDays(form),
    time_zone: form.timeZone || null,
  };
}

/** How many campaigns saving would link. Drives the live hint under the name. */
export function linkPreviewCount(
  name: string,
  instantly: readonly NamedCampaign[],
  bison: readonly NamedCampaign[],
): number {
  return autoMatchCampaignIds(name, instantly).length + autoMatchCampaignIds(name, bison).length;
}

/** The tool's own wording for that hint. */
export function linkPreviewText(name: string, count: number): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "Instantly + Bison campaigns whose name contains this client name are auto-linked on save.";
  }
  if (count === 0) {
    return `No campaign contains “${trimmed}” — this client will be saved without any linked campaigns.`;
  }
  return `Will auto-link ${count} matching campaign${count === 1 ? "" : "s"}.`;
}

/**
 * The confirmation shown before a delete.
 *
 * It names the count because the delete cascades: the client's weekly metrics
 * go, and so do campaign cache rows no other client references. "Are you sure?"
 * would not tell anybody what they are about to lose.
 */
export function deleteConfirmText(c: DashboardClient): string {
  const linked = (c.instantly_campaign_ids?.length ?? 0) + (c.bison_campaign_ids?.length ?? 0);
  if (linked > 0) {
    return (
      `Removing ${c.name} will also delete their weekly metrics and ${linked} linked ` +
      `campaign cache row${linked === 1 ? "" : "s"} (campaigns linked to no other client). Continue?`
    );
  }
  return `Remove ${c.name}? Their weekly metrics will also be deleted.`;
}

/**
 * A newly created client, as the table needs it before the next reload.
 *
 * Every field the row reads has to be present or the screen throws on the
 * client it just added — the one moment somebody is definitely looking at it.
 */
export function optimisticClient(id: string, payload: ClientPayload): DashboardClient {
  return {
    ...payload,
    id,
    campaign_size: 0,
    hidden: false,
    client_paused: false,
    portal_active: false,
    emails_today: 0,
    emails_today_date: null,
    portal_synced_at: null,
    dnc_count: 0,
    agents_count: 0,
    last_lead_activity_at: null,
    stagnant_intros_count: 0,
    intros_since_last_billing: 0,
    intros_this_month: 0,
    portal_url: null,
    total_intros_corofy: 0,
    total_interested_corofy: 0,
    campaigns: [],
    bisonCampaigns: [],
    metricsByWeek: {},
    portalActive: false,
  };
}
