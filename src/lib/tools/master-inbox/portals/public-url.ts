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
