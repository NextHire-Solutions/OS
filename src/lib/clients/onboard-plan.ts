/*
 * What onboarding a client in the OS would send to each tool.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PURE FUNCTION
 *
 * Onboarding spends real, irreversible things. Master Inbox's insert mints a
 * `portal_token` that is live and login-free the moment it exists — a mistake
 * there is not a bad row, it is a wrong URL in a customer's hands. So "click it
 * and see" is not an available way to check the request is right.
 *
 * This builds the requests WITHOUT sending them, so they can be unit-tested,
 * shown on screen before anything runs, and stored verbatim in
 * `os_client_onboarding.request` afterwards. Exactly the pattern Agent Search
 * uses for `buildSearchPayload`, for the same reason.
 *
 * ---------------------------------------------------------------------------
 * THREE LEGS, NOT FOUR
 *
 * Analytics, Client Health, Master Inbox. The Onboarding tool is deliberately
 * NOT written to: a client created in the OS does not belong in that tool's
 * intake pipeline, which exists to process Typeform submissions. The flow runs
 * the other way — a client the Onboarding tool creates is adopted INTO this
 * list.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS THE SAFETY MECHANISM
 *
 * Cheapest-to-undo first, Master Inbox last, because it is the only leg with an
 * externally visible consequence. If Analytics or Client Health fails, nothing
 * has reached a customer and the whole thing can be retried.
 *
 * Every validation rule below was read from the tool it guards, so a plan that
 * passes here is one the tool will accept — a dry run that is optimistic is
 * worse than none.
 */

import { toSlug } from "./slug.ts";

export const PLANS = ["minimum", "production", "partner"] as const;
export const BILLING_INTERVALS = ["biweekly", "28-days", "monthly", "custom"] as const;
export const MATCH_MODES = ["contains", "prefix", "exact"] as const;

export type Plan = (typeof PLANS)[number];
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
export type MatchMode = (typeof MATCH_MODES)[number];

/** The legs, in the order they must run. */
export const LEGS = ["analytics", "client_health", "database", "master_inbox"] as const;
export type Leg = (typeof LEGS)[number];

export interface IntroMacro {
  brokerage: string;
  clientFullName: string;
  clientFirstName: string;
  clientRole: string;
  /*
   * The contact's address. Optional, and never required by the validator: a
   * macro without one is still a usable macro, it just does not copy anybody
   * in. Becomes the created template's Cc, and is stored on the OS record for
   * the composer's Introduce button.
   */
  contactEmail?: string;
  /*
   * A second and third person to introduce to, when the client has them.
   *
   * These never travel to Master Inbox: its onboarding endpoint is deployed
   * and understands one contact, so it still creates a one-person template
   * exactly as it always has. They are stored on the OS record, and the
   * template is re-rendered from all of them straight afterwards. That keeps
   * the payload this app sends byte-identical to what it sent before.
   */
  extraContacts?: Array<{ name?: string; role?: string; email?: string }>;
}

export interface OnboardInput {
  name: string;
  plan: Plan;
  weeklyTarget: number;
  aliases?: string[];
  startDate?: string;
  billingAnchorDate?: string;
  billingInterval?: BillingInterval;
  billingIntervalDays?: number;
  monthlyTarget?: number;
  matchMode?: MatchMode;
  introMacro?: IntroMacro;
}

export interface PlannedCall {
  leg: Leg;
  tool: string;
  method: "POST";
  /** Path only. The host comes from config at send time, never from input. */
  path: string;
  /** How it authenticates — the NAME of the secret, never its value. */
  auth: string;
  body: Record<string, unknown>;
  /** What the tool does on top of inserting the row. */
  sideEffects: string[];
  /** Present when the leg cannot be undone. */
  irreversible?: string;
}

export interface OnboardPlan {
  ok: boolean;
  errors: string[];
  warnings: string[];
  slug: string;
  calls: PlannedCall[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/*
 * Defaults match the Onboarding tool's existing pushes (lib/connectors/apps.ts)
 * so a client onboarded here and one pushed from there come out the same. They
 * are not invented: `plan` and `weekly_target` are that connector's literal
 * fallbacks.
 */
export const DEFAULTS = {
  plan: "production" as Plan,
  weeklyTarget: 3,
  billingInterval: "biweekly" as BillingInterval,
  matchMode: "contains" as MatchMode,
};

export function planOnboarding(input: OnboardInput): OnboardPlan {
  const errors: string[] = [];
  const warnings: string[] = [];

  const name = (input.name ?? "").trim();
  if (!name) errors.push("Name is required.");
  // Master Inbox caps the name at 80; Analytics allows 200. The tighter of the
  // two wins, because a name that only three tools accept is a half-made client.
  if (name.length > 80) errors.push(`Name is ${name.length} characters; Master Inbox allows 80.`);

  if (!PLANS.includes(input.plan)) {
    errors.push(`Plan must be one of ${PLANS.join(", ")}.`);
  }

  const weeklyTarget = Number(input.weeklyTarget);
  if (!Number.isInteger(weeklyTarget) || weeklyTarget < 0) {
    errors.push("Weekly target must be a whole number of 0 or more.");
  }

  const aliases = (input.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  if (aliases.length > 20) errors.push("At most 20 aliases.");
  if (aliases.some((a) => a.length > 120)) errors.push("An alias may be at most 120 characters.");

  for (const [label, value] of [
    ["Start date", input.startDate],
    ["Billing anchor date", input.billingAnchorDate],
  ] as const) {
    if (value && !ISO_DATE.test(value)) errors.push(`${label} must be YYYY-MM-DD.`);
  }

  const billingInterval = input.billingInterval ?? DEFAULTS.billingInterval;
  if (!BILLING_INTERVALS.includes(billingInterval)) {
    errors.push(`Billing interval must be one of ${BILLING_INTERVALS.join(", ")}.`);
  }
  if (billingInterval === "custom" && !Number.isInteger(Number(input.billingIntervalDays))) {
    errors.push('Billing interval days is required when the interval is "custom".');
  }
  if (input.billingIntervalDays != null && Number(input.billingIntervalDays) <= 0) {
    errors.push("Billing interval days must be a positive whole number.");
  }

  const matchMode = input.matchMode ?? DEFAULTS.matchMode;
  if (!MATCH_MODES.includes(matchMode)) {
    errors.push(`Match mode must be one of ${MATCH_MODES.join(", ")}.`);
  }

  const macro = input.introMacro;
  if (macro) {
    const missing = (["brokerage", "clientFullName", "clientFirstName", "clientRole"] as const)
      .filter((k) => !(macro[k] ?? "").trim());
    if (missing.length) {
      errors.push(`Intro macro needs ${missing.join(", ")} — Master Inbox rejects an empty one.`);
    }
  } else {
    warnings.push(
      "No intro macro, so no “Intro Macro — <client>” reply template is created. " +
        "It can be added later from Settings → Templates.",
    );
  }

  if (!input.startDate) {
    warnings.push("No start date, so Client Health's movement table will not count this client.");
  }

  const slug = toSlug(name);

  /* ------------------------------------------------------------ the calls */

  const analytics: PlannedCall = {
    leg: "analytics",
    tool: "Campaign Analytics",
    method: "POST",
    path: "/api/clients",
    auth: "Analytics session (ANALYTICS_AUTH_SECRET)",
    body: { name, aliases, matchMode },
    sideEffects: [
      "Inserts a client row with team_id, name, slug, aliases, match_mode.",
      "No campaigns are attributed yet — the sync job does that on its next run, " +
        "using the token-run matcher.",
    ],
  };

  const clientHealthBody: Record<string, unknown> = {
    name,
    plan: input.plan,
    weekly_target: weeklyTarget,
    billing_interval: billingInterval,
  };
  if (input.startDate) clientHealthBody.start_date = input.startDate;
  if (input.billingAnchorDate) clientHealthBody.billing_anchor_date = input.billingAnchorDate;
  if (input.billingIntervalDays != null) {
    clientHealthBody.billing_interval_days = Number(input.billingIntervalDays);
  }

  const clientHealth: PlannedCall = {
    leg: "client_health",
    tool: "Client Health",
    method: "POST",
    // Deliberately /onboard, not /clients: the plain route skips validation
    // AND campaign auto-linking, so a client created through it looks fine and
    // silently reports zero sends. The workspace's own route — the live tool's
    // /api/clients/onboard, ported — and the run calls its logic in-process.
    path: "/api/tools/client-health/clients/onboard",
    auth: "in-process (CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY)",
    body: clientHealthBody,
    sideEffects: [
      "Auto-links matching Instantly and EmailBison campaigns by normalised name.",
      "Refuses with 409 if a client of this name already exists (case-insensitive).",
    ],
  };

  /*
   * The Database record: one row in orch_clients. §2 lists it among the things
   * creating a client should do automatically, and it was the gap in §21 step 3.
   *
   * Runs BEFORE Master Inbox because Master Inbox is the irreversible leg, and
   * the same rule applies to this one as to the others: nothing customer-facing
   * is created until every reversible leg has succeeded.
   */
  const database: PlannedCall = {
    leg: "database",
    tool: "Database",
    method: "POST",
    path: "(in-process) orch_clients insert",
    auth: "in-process (AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY, orch_* write guard)",
    body: { client_name: name, status: "new" },
    sideEffects: [
      "Inserts one orch_clients row — that is the entire Database record.",
      "The client then appears in the Database app's Client filter, Clients page and pickers.",
      "Links to an existing row instead of inserting when the normalised name already exists: " +
        "two rows sharing a key make the campaign matcher abandon both clients.",
      "Leads and campaigns are NOT attached here — the six-hourly campaign sync does that.",
    ],
  };

  const masterInboxBody: Record<string, unknown> = { name, aliases };
  if (macro) {
    masterInboxBody.intro_macro = {
      brokerage: macro.brokerage.trim(),
      client_full_name: macro.clientFullName.trim(),
      client_first_name: macro.clientFirstName.trim(),
      client_role: macro.clientRole.trim(),
      ...(macro.contactEmail?.trim() ? { contact_email: macro.contactEmail.trim() } : {}),
    };
  }

  const masterInbox: PlannedCall = {
    leg: "master_inbox",
    tool: "Master Inbox",
    method: "POST",
    path: "/api/clients",
    auth: "x-admin-token (MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY)",
    body: masterInboxBody,
    sideEffects: [
      `Generates slug "${slug}".`,
      "Creates a portal token and enables the portal.",
      "Turns on manage_stages, pipeline_kanban_view and pipeline_board_enhanced.",
      "Re-tags any “Unknown” threads whose campaign name matches this client or an alias.",
      "Creates the sidebar list for this client.",
      ...(macro ? [`Creates the reply template “Intro Macro - ${name}”.`] : []),
    ],
    irreversible:
      "This mints a live, login-free portal URL. It runs last for that reason: " +
      "if an earlier leg fails, no customer-facing address has been created.",
  };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    slug,
    // LEGS order is the run order. Not sorted here — the array literal IS the
    // contract, and a caller must not have to know to sort it.
    calls: [analytics, clientHealth, database, masterInbox],
  };
}
