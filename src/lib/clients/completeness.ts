import type { MasterClient } from "./master-list";
import { effectiveSignup } from "./signup";

/*
 * PROFILE COMPLETENESS (client feedback, 6 Oct): what a complete client record
 * has, what this one is missing, and exactly where each gap is filled. Pure —
 * the Clients list and the record both compute it from the client as shown.
 *
 * Each check names the record tab it is fixed on and how; the record turns
 * that into a "Fix →" button. Stripe and saved views arrive after the list, so
 * until they do those checks are `pending`, never counted as missing.
 */

export type FixTab = "record" | "markets" | "introduce" | "campaigns";

export interface ProfileCheck {
  key: string;
  label: string;
  ok: boolean;
  /** Not known yet (Stripe or the Database still loading) — neither done nor missing. */
  pending?: boolean;
  tab: FixTab;
  /** The field to open on that tab, when there is one. */
  field?: string;
  how: string;
}

const has = (v: unknown) => (typeof v === "string" ? v.trim().length > 0 : v !== null && v !== undefined);

export function profileChecks(c: MasterClient): ProfileCheck[] {
  const m = c.markets;
  const signup = effectiveSignup(c);
  const stripePending = c.stripe === undefined;
  const viewsPending = c.savedViews === undefined;
  return [
    { key: "plan", label: "Plan", ok: has(c.plan), tab: "record", field: "plan", how: "Choose the plan on the Record tab." },
    { key: "onboardingDate", label: "Onboarding date", ok: has(c.onboardingDate), tab: "record", field: "onboardingDate", how: "Enter the day onboarding began on the Record tab." },
    { key: "signupDate", label: "Sign-up date", ok: !!signup.date, pending: stripePending && !signup.date, tab: "record", field: "signupDate",
      how: "Comes from the client's first $1 charge in Stripe. With none, enter it on the Record tab." },
    { key: "accountManager", label: "Account manager", ok: has(c.accountManager), tab: "record", field: "accountManager", how: "Choose one on the Record tab (a Team access member with the Account manager role)." },
    { key: "salesperson", label: "Salesperson", ok: has(c.salesperson), tab: "record", field: "salesperson", how: "Choose who sold the client on the Record tab." },
    { key: "sender", label: "Sender", ok: has(c.sender), tab: "record", field: "sender", how: "Enter the sending identity on the Record tab." },
    { key: "website", label: "Website", ok: has(c.website), tab: "record", field: "website", how: "Enter it on the Record tab." },
    { key: "zillowUrl", label: "Zillow profile", ok: has(c.zillowUrl), tab: "record", field: "zillowUrl", how: "Paste the Zillow profile link on the Record tab." },
    { key: "pocName", label: "POC name", ok: has(c.pocName), tab: "record", field: "pocName", how: "Enter the client's point of contact on the Record tab." },
    { key: "pocEmail", label: "POC email", ok: has(c.pocEmail), tab: "record", field: "pocEmail", how: "Enter the point of contact's email on the Record tab." },
    { key: "timezone", label: "Timezone", ok: has(c.timezone), tab: "record", field: "timezone", how: "Choose it on the Record tab (needs the client linked to Client Health)." },
    { key: "billing", label: "Billing schedule", ok: has(c.billingInterval) && has(c.billingAnchorDate), tab: "record", field: "billingAnchorDate",
      how: "Set the billing interval and anchor date on the Record tab (needs Client Health)." },
    { key: "monthlyTarget", label: "Monthly intro target", ok: typeof c.monthlyTarget === "number" && c.monthlyTarget > 0, tab: "record", field: "monthlyTarget", how: "Enter it on the Record tab." },
    { key: "market", label: "Markets", ok: !!m && typeof m.markets === "number" && m.markets > 0, tab: "markets", how: "Enter how many markets on the Markets tab." },
    { key: "mls", label: "MLS", ok: !!m && m.mls.length > 0, tab: "markets", how: "Add the MLS boards on the Markets tab." },
    { key: "area", label: "Area", ok: !!m && m.areas.length > 0, tab: "markets", how: "Add the areas on the Markets tab." },
    { key: "introPerson", label: "Who leads are introduced to", ok: has(c.contact.name) && has(c.contact.role) && has(c.contact.email),
      tab: "introduce", how: "Add the first person's name, role and email on the Introduce to tab." },
    { key: "brokerage", label: "Brokerage", ok: has(c.contact.brokerage), tab: "introduce", how: "Enter the brokerage named in introductions on the Introduce to tab." },
    { key: "stripe", label: "Stripe subscription", ok: has(c.stripeSubscriptionId) || (c.stripe?.subscriptions ?? 0) > 0,
      pending: stripePending && !has(c.stripeSubscriptionId), tab: "record", field: "stripeSubscriptionId",
      how: "Link the Stripe subscription in Billing on the Record tab, or create one there with a payment link." },
    { key: "savedViews", label: "Saved view", ok: (c.savedViews?.length ?? 0) > 0, pending: viewsPending, tab: "campaigns",
      how: "Save a view in the Database named after the client, or link an existing one under Saved views on the Campaigns tab." },
    { key: "leads", label: "Leads assigned", ok: typeof c.assignedLeads === "number" && c.assignedLeads > 0, tab: "campaigns",
      how: "Leads are built in the Database / Onboarding for the client's campaigns." },
    { key: "portal", label: "Client portal", ok: c.portal.count > 0, tab: "campaigns", how: "The portal is created when the client is onboarded; add one on the Campaigns tab." },
  ];
}

export interface Completeness { pct: number; done: number; total: number; missing: ProfileCheck[]; pending: number }

/** Share of the checks that are done, of those that are known. */
export function completeness(c: MasterClient): Completeness {
  const checks = profileChecks(c);
  const known = checks.filter((k) => !k.pending);
  const done = known.filter((k) => k.ok).length;
  return {
    pct: known.length ? Math.round((done / known.length) * 100) : 0,
    done,
    total: known.length,
    missing: known.filter((k) => !k.ok),
    pending: checks.length - known.length,
  };
}
