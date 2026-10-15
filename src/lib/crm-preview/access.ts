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
 */
export const PREVIEW_REVIEWERS: readonly string[] = ["eddy@brokerstaffer.com"];

export function canSeeCrmPreview(email: string | null | undefined, owners: readonly string[]): boolean {
  if (!email) return false;
  const key = email.trim().toLowerCase();
  if (!key) return false;
  if (PREVIEW_REVIEWERS.includes(key)) return true;
  return owners.length > 0 && owners.some((o) => o.trim().toLowerCase() === key);
}
