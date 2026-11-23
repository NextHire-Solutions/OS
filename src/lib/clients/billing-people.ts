import "server-only";

import { osTable } from "@/lib/clients/os-db";

import { BILLING_TAB_PEOPLE, CANCEL_SUBSCRIPTION_PEOPLE } from "./billing-access";

/*
 * WHO HAS THE BILLING TAB (24 Nov 2026, Eddy, via the user): "Every Account Manager gets the whole Billing tab,
 * including refunds and cancel." So: the people named in billing-access.ts (the user's own account and Eddy), and every
 * ACTIVE team member with the Account manager title on Team access (os_users.is_account_manager). Same rule for the tab,
 * its routes (refunds, cancel, invoice email, pay per lead, documents), a staff member's "Manage billing" in a portal and
 * the Assistant's billing tools.
 *
 * Read from os_users, cached a minute (shared across Next's bundles via globalThis). If the table can't be read, only the
 * named people pass: it never opens wider by accident.
 */
type Cache = { at: number; managers: Set<string> | null };
const CACHE_MS = 60_000;
const g = globalThis as unknown as { __billingManagers?: Cache; __billingManagersLoad?: Promise<Set<string> | null> };

const norm = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

/** Active Account Managers' addresses, or null when os_users can't be read. */
export async function billingAccountManagers(): Promise<Set<string> | null> {
  const c = g.__billingManagers;
  if (c && Date.now() - c.at < CACHE_MS) return c.managers;
  g.__billingManagersLoad ??= (async () => {
    try {
      const { data, error } = await osTable("os_users").select("email").eq("is_account_manager", true).eq("is_active", true);
      if (error) throw new Error(error.message);
      return new Set(((data ?? []) as Array<{ email: string | null }>).map((r) => norm(r.email)).filter(Boolean));
    } catch (e) {
      console.error(JSON.stringify({ at: "[billing-people] account managers unreadable — named people only", error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
      return null;
    }
  })().then((managers) => {
    g.__billingManagers = { at: Date.now(), managers };
    return managers;
  }).finally(() => { g.__billingManagersLoad = undefined; });
  return g.__billingManagersLoad;
}

/** The Billing tab and its routes: a named person, or an active Account Manager. */
export async function canUseBillingTab(email: string | null | undefined): Promise<boolean> {
  const key = norm(email);
  if (!key) return false;
  if (BILLING_TAB_PEOPLE.includes(key)) return true;
  return (await billingAccountManagers())?.has(key) ?? false;
}

/** Cancelling a subscription: the same people as the tab (24 Nov: "including refunds and cancel"). */
export async function canCancelSubscription(email: string | null | undefined): Promise<boolean> {
  const key = norm(email);
  if (!key) return false;
  if (CANCEL_SUBSCRIPTION_PEOPLE.includes(key)) return true;
  return (await billingAccountManagers())?.has(key) ?? false;
}

/** Tests only: forget the cached list. */
export function _resetBillingPeopleCache(): void {
  g.__billingManagers = undefined;
  g.__billingManagersLoad = undefined;
}
