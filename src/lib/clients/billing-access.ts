/*
 * Who may see the client record's Billing tab (19 Oct) — the centralised
 * billing section Eddy asked for: current billing, total billed, every
 * payment, failed payment and refund, and every invoice.
 *
 * EXACTLY these two people, by name. The user, 19 Oct: "only
 * admin@outreachify and eddy's email address should be able to access this.
 * no one else should be able to see this. this is very important".
 *
 * Deliberately NOT the ADMIN_EMAILS list (an Owner added there later does not
 * get it), not people marked Admin on Team access, not account managers, not
 * anyone with the Clients page, and there is no Team access switch for it.
 * Everyone else keeps the record exactly as before: the Stripe control and
 * the billing fields on the Record tab, under the rules they already had.
 *
 * Change this list only on the user's word.
 */
export const BILLING_TAB_PEOPLE: readonly string[] = ["admin@outreachify.io", "eddy@brokerstaffer.com"];

export function canSeeBillingTab(email: string | null | undefined): boolean {
  const key = (email ?? "").trim().toLowerCase();
  return key.length > 0 && BILLING_TAB_PEOPLE.includes(key);
}
