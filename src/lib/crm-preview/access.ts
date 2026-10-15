/*
 * Who may open the CRM redesign preview (/crm-preview).
 *
 * Owners only — the ADMIN_EMAILS list. Not people marked Admin on Team access,
 * not account managers, and there is no Team access switch for it. The user,
 * 15 Oct: "not all team should see this. also do not add this to product
 * switch too under team access. only we should be able to see this".
 *
 * Fails closed: with ADMIN_EMAILS unset nobody qualifies. (isAdmin() falls
 * back to everyone in AUTH_USERS when it is unset; this deliberately does not.)
 */
export function canSeeCrmPreview(email: string | null | undefined, owners: readonly string[]): boolean {
  if (!email) return false;
  const key = email.trim().toLowerCase();
  if (!key || owners.length === 0) return false;
  return owners.some((o) => o.trim().toLowerCase() === key);
}
