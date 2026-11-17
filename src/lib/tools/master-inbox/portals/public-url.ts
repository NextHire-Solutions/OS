// Public-facing host for the client portal.
//
// Everywhere staff UI surfaces a portal URL (admin overview's "copy
// link" / "open live portal", per-client drill-down, eventually
// email templates), the URL must point at the brokerage-facing
// domain — NOT the Railway URL. The Railway URL works internally
// for staff bookmarks, but anything we share/copy/click-through to
// must read as `portal.brokerstaffer.com/portal/<token>`.
//
// Hoisted to a single constant so a future change (different
// subdomain, secondary brand, etc.) lands in one place.
export const PUBLIC_PORTAL_HOST = "portal.brokerstaffer.com";

export function publicPortalUrl(token: string | null | undefined): string | null {
  if (!token) return null;
  return `https://${PUBLIC_PORTAL_HOST}/portal/${token}`;
}

// The NEW client portal (17 Nov): it lives in the OS, one address per portal
// id, and opens only after sign-in (OS staff, or someone on that portal's
// sign-in list; the Demo Portal's list is its testers). Not login-free like
// the old link above.
export const PUBLIC_OS_HOST = "os.brokerstaffer.com";

/** Same-site path to a portal in the new client portal (for links that open it). */
export function newPortalPath(portalId: string): string {
  return `/crm-preview?client=${encodeURIComponent(portalId)}`;
}

/** The full address of a portal in the new client portal (to show and to copy). */
export function newPortalUrl(portalId: string): string {
  return `https://${PUBLIC_OS_HOST}${newPortalPath(portalId)}`;
}
