/*
 * Who is looking at the new portal, which portals they may open, and which they may change (27–28 Oct).
 *
 * STAFF — the preview's reviewers (access.ts: Owners, Eddy, Amy, by name) —
 * open any portal, exactly as before. They change only the Demo Portal; every
 * real portal is read-only to them in the preview (a client's records are the
 * client's to change, from their own sign-in).
 *
 * A CLIENT — someone signed in at /portal-signin (lib/portal-login) — opens
 * only the portals their address is on the list for, AND only a portal on
 * OPEN_PORTALS, below. On a portal open to them they change their own records,
 * as their current portal does (portal-save.ts).
 *
 * The user, 27 Oct: "make sure even after deploying client's should see the
 * older portals only until I tell you to switch". Every real client keeps their
 * current portal until their line is added to OPEN_PORTALS — a change HERE, on
 * the user's word, never a role, a switch or a setting someone could flip.
 */

import { isDemoPortal, DEMO_PORTAL_ID } from "./demo.ts";

/*
 * THE NAMED TESTERS (security review, 27 Oct). The Demo is one shared space:
 * its pipeline holds real email threads, its saves copy agents (names, phones)
 * out of the agent database, and its DNC list is read by the live reply
 * agent's safety check. Anyone with the Client Portals switch can put an
 * address on a sign-in list — so the list alone never opens a "testers"
 * portal. Only these, by name: the user's own account and the preview's
 * reviewers (access.ts).
 */
export const DEMO_CLIENT_TESTERS: readonly string[] = ["admin@outreachify.io", "eddy@brokerstaffer.com", "amy@brokerstaffer.com"];

/** BrokerStaffer's own portal (Master Inbox `clients`) — the house account, never counted as a client. */
export const BROKERSTAFFER_PORTAL_ID = "54322dcf-7392-4022-918c-990ebc8469b8";

/*
 * THE PORTALS OPEN TO CLIENTS, and to whom.
 *   "testers"  only DEMO_CLIENT_TESTERS (and only while their address is on the portal's sign-in list)
 *   "listed"   every address on the portal's sign-in list — a real client, switched to the new portal
 * The Demo, and BrokerStaffer's own portal as the pilot (the user, 28 Oct: "BrokerStaffer's own portal" first,
 * opened only to the testers — saves there are real, with everything the current portal sets off). A real
 * client is switched by adding `[their portal id]: "listed"`, on the user's word.
 */
export const OPEN_PORTALS: Readonly<Record<string, "testers" | "listed">> = {
  [DEMO_PORTAL_ID]: "testers",
  [BROKERSTAFFER_PORTAL_ID]: "testers",
};

export type CrmViewer =
  | { kind: "staff"; email: string }
  | { kind: "client"; email: string; portals: string[] };

/** Does a portal open this way let this address in? (Pure — OPEN_PORTALS says which way each portal opens.) */
export function opensTo(rule: "testers" | "listed" | undefined, email: string | null | undefined): boolean {
  const who = (email ?? "").trim().toLowerCase();
  if (rule === "listed") return who.length > 0;
  return rule === "testers" && DEMO_CLIENT_TESTERS.includes(who);
}

/** May this signed-in address open this portal in the new design yet? */
export function openToClients(portalId: string | null | undefined, email: string | null | undefined): boolean {
  return opensTo(portalId ? OPEN_PORTALS[portalId] : undefined, email);
}

/** Of the portals a client's address is on the list for, the ones they may open now. */
export function clientPortals(listed: readonly string[], email: string): string[] {
  return [...new Set(listed)].filter((id) => openToClients(id, email));
}

/** May this viewer open this portal? Staff: any. A client: their own, and open to clients. */
export function mayOpenPortal(v: CrmViewer | null, portalId: string | null | undefined): boolean {
  if (!v || !portalId) return false;
  if (v.kind === "staff") return true;
  return v.portals.includes(portalId) && openToClients(portalId, v.email);
}

/**
 * May this viewer CHANGE this portal from the new design? The Demo Portal: anyone who may open it (its saves are
 * its own rows, nothing outside — demo.ts). A real portal: only its own signed-in client, once it is open to them —
 * never staff from the preview.
 */
export function mayWritePortal(v: CrmViewer | null, portalId: string | null | undefined): boolean {
  if (!v || !portalId) return false;
  if (isDemoPortal(portalId)) return mayOpenPortal(v, portalId);
  return v.kind === "client" && mayOpenPortal(v, portalId);
}

/** How the data guard and the usage counts treat this viewer. */
export const guardRole = (v: CrmViewer) => (v.kind === "client" ? ("client" as const) : ("staff" as const));
