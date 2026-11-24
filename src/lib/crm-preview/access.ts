/*
 * Who may open the CRM redesign preview (/crm-preview).
 *
 * Owners only — the ADMIN_EMAILS list. Not people marked Admin on Team access,
 * not account managers, and there is no Team access switch for it. The user,
 * 15 Oct: "not all team should see this. also do not add this to product
 * switch too under team access. only we should be able to see this".
 *
 * Fails closed: with ADMIN_EMAILS unset no Owner qualifies. (isAdmin() falls
 * back to everyone in AUTH_USERS when it is unset; this deliberately does not.)
 *
 * And, by name, the people the user chose to review it with. 16 Oct: Eddy
 * said "Do not launch this new CRM until we've reviewed it on Demo Portal or
 * on a staging environment", and the user chose to open this preview to him
 * — only him, not every admin. Add a reviewer here, never by role or switch.
 * 20 Oct, the user: "can we make this new client portal available to amy?" —
 * Amy Anderes (amy@brokerstaffer.com), added by name.
 * 3 Nov, the user ("yes add him"): Gabriel Castillo, account manager
 * (gabo075823532@gmail.com) — every client's new portal, as Eddy and Amy. Not
 * a client's Stripe billing page ("Manage billing"): that stays with the
 * Billing tab's people (clients/billing-access.ts).
 */
export const PREVIEW_REVIEWERS: readonly string[] = ["eddy@brokerstaffer.com", "amy@brokerstaffer.com", "gabo075823532@gmail.com"];

/*
 * 24 Nov — the client: "Fix the Portal button on the client record … Update the button to open the new Client
 * Portal." The button can only do that for staff the new portal lets in, so it also opens to staff with the
 * Client Portals switch (`portals`, Team access). They can already open every client's OLD portal (its login-free
 * link) from the Client Portals screen, so nobody reaches a portal they couldn't before. Staff without that switch
 * are still refused, and the record hides the button from them. This reverses the 15 Oct "only we" rule above for
 * that switch: to undo, drop the `grants` line below.
 */
export function canSeeCrmPreview(email: string | null | undefined, owners: readonly string[], grants: readonly string[] = []): boolean {
  if (!email) return false;
  const key = email.trim().toLowerCase();
  if (!key) return false;
  if (PREVIEW_REVIEWERS.includes(key)) return true;
  if (grants.includes("portals")) return true;
  return owners.length > 0 && owners.some((o) => o.trim().toLowerCase() === key);
}
