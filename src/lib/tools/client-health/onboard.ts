import type { SupabaseClient } from "@supabase/supabase-js";

import { createClientRow, type ClientRow, type WriteResult } from "./clientWrites.ts";
import { autoMatchCampaignIds } from "./matchCampaigns.ts";

/*
 * Inbound onboarding — the tool's POST /api/clients/onboard, as a function.
 *
 * An outside caller (the OS's own onboarding run, Corofy onboarding, Zapier)
 * sends the fields it knows about a new client — name, plan, weekly target,
 * onboarding date, billing schedule — and this auto-links matching Instantly
 * and EmailBison campaigns using the SAME name-matching rule the Add-Client
 * modal applies (matchCampaigns.ts, byte-identical to the tool's).
 *
 * Why it exists separately from createClientRow: the plain create stores the
 * ids it is given and validates nothing about names. A client made through
 * it with no ids looks fine and silently reports zero sends for ever. This
 * is the route the onboarding leg must use, and the reason the plan says so.
 *
 * Ported behaviour, in the tool's order:
 *
 *   · name, plan, weekly_target required; dates must be YYYY-MM-DD;
 *     billing_interval defaults to "biweekly"; "custom" needs
 *     billing_interval_days.
 *   · a case-insensitive exact duplicate of the name is refused with 409 and
 *     the existing id, so a retry cannot create a second row.
 *   · server-managed fields (campaign ids, flags, today's counters) supplied
 *     by the caller are ignored — the row is built from the validated fields
 *     only, and then goes through createClientRow's allow-list on top.
 *
 * The write itself goes through clientWrites.ts so there is one validation
 * path for every client row this workspace creates.
 */

const PLANS = ["minimum", "production", "partner"] as const;
const INTERVALS = ["biweekly", "28-days", "monthly", "custom"] as const;
type Plan = (typeof PLANS)[number];
type Interval = (typeof INTERVALS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface OnboardOutcome {
  client: ClientRow;
  linked: { instantly: string[]; bison: string[] };
}

/** A 409 carries the existing row's id so the caller can link to it instead. */
export type OnboardResult =
  | WriteResult<OnboardOutcome>
  | { ok: false; status: 409; error: string; existing_id: string };

const bad = (error: string, status = 400): { ok: false; status: number; error: string } =>
  ({ ok: false, status, error });

export async function onboardClient(db: SupabaseClient, input: unknown): Promise<OnboardResult> {
  const body = (input && typeof input === "object" && !Array.isArray(input)
    ? input
    : null) as Record<string, unknown> | null;
  if (!body) return bad("invalid JSON body");

  // --- required fields ---
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return bad("name is required");

  const plan = body.plan as Plan;
  if (!PLANS.includes(plan)) return bad(`plan must be one of ${PLANS.join(", ")}`);

  const weeklyTarget = Number(body.weekly_target);
  if (!Number.isInteger(weeklyTarget) || weeklyTarget < 0) {
    return bad("weekly_target must be an integer >= 0");
  }

  // --- optional fields ---
  const startDate = body.start_date == null ? null : String(body.start_date);
  if (startDate && !ISO_DATE.test(startDate)) return bad("start_date must be YYYY-MM-DD");

  const billingAnchorDate = body.billing_anchor_date == null ? null : String(body.billing_anchor_date);
  if (billingAnchorDate && !ISO_DATE.test(billingAnchorDate)) {
    return bad("billing_anchor_date must be YYYY-MM-DD");
  }

  const billingInterval = (body.billing_interval as Interval | undefined) ?? "biweekly";
  if (!INTERVALS.includes(billingInterval)) {
    return bad(`billing_interval must be one of ${INTERVALS.join(", ")}`);
  }

  let billingIntervalDays: number | null = null;
  if (body.billing_interval_days != null) {
    const n = Number(body.billing_interval_days);
    if (!Number.isInteger(n) || n <= 0) return bad("billing_interval_days must be a positive integer");
    billingIntervalDays = n;
  }
  if (billingInterval === "custom" && billingIntervalDays == null) {
    return bad('billing_interval_days is required when billing_interval="custom"');
  }

  // Duplicate-name guard — case-insensitive exact match.
  const dupe = await db.from("clients").select("id, name").ilike("name", name).limit(1);
  if (dupe.error) return bad(dupe.error.message, 500);
  if (dupe.data && dupe.data.length > 0) {
    return {
      ok: false,
      status: 409,
      error: "client with this name already exists",
      existing_id: String((dupe.data[0] as { id: unknown }).id),
    };
  }

  // Auto-link campaigns by normalised-name substring — same rule as the
  // Add-Client modal in the dashboard.
  const [instantlyRes, bisonRes] = await Promise.all([
    db.from("instantly_campaigns").select("id, name"),
    db.from("bison_campaigns").select("id, name"),
  ]);
  if (instantlyRes.error) return bad(instantlyRes.error.message, 500);
  if (bisonRes.error) return bad(bisonRes.error.message, 500);

  type Named = { id: string; name: string };
  const instantlyIds = autoMatchCampaignIds(name, (instantlyRes.data ?? []) as Named[]);
  const bisonIds = autoMatchCampaignIds(name, (bisonRes.data ?? []) as Named[]);

  const created = await createClientRow(db, {
    name,
    plan,
    weekly_target: weeklyTarget,
    start_date: startDate,
    billing_anchor_date: billingAnchorDate,
    billing_interval: billingInterval,
    billing_interval_days: billingIntervalDays,
    instantly_campaign_ids: instantlyIds,
    bison_campaign_ids: bisonIds,
  });
  if (!created.ok) {
    // The tool answers an insert failure with 500; a validation failure here
    // would already have been caught above, so keep its status.
    return { ok: false, status: created.status === 400 ? 500 : created.status, error: created.error };
  }

  return { ok: true, value: { client: created.value, linked: { instantly: instantlyIds, bison: bisonIds } } };
}
