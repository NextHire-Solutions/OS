/*
 * Who is looking at the new portal, and which portals they may open (27 Oct).
 *
 * STAFF — the preview's reviewers (access.ts: Owners, Eddy, Amy, by name) —
 * open any portal, exactly as before.
 *
 * A CLIENT — someone signed in at /portal-signin (lib/portal-login) — opens
 * only the portals their address is on the list for, AND only a portal that
 * is open to clients. Until the user says to switch, that is the Demo Portal
 * alone. The user, 27 Oct: "make sure even after deploying client's should
 * see the older portals only until I tell you to switch". Every real client
 * keeps their current portal; signing in shows them the holding page.
 *
 * Opening a real client's portal to its clients is a change HERE, on the
 * user's word — never a role, a switch or a setting someone could flip.
 */

import { isDemoPortal } from "./demo.ts";

/*
 * THE DEMO PORTAL OPENS AS A CLIENT ONLY TO NAMED PEOPLE (security review,
 * 27 Oct). It is one shared space: its pipeline holds real email threads, its
 * saves copy agents (names, phones) out of the agent database, and its DNC
 * list is read by the live reply agent's safety check. Anyone with the Client
 * Portals switch can put an address on its sign-in list — so the list alone
 * never opens it. Only these, by name: the user's own account and the
 * preview's reviewers (access.ts). A real client is never put on the Demo;
 * at the switch they get their own portal.
 */
export const DEMO_CLIENT_TESTERS: readonly string[] = ["admin@outreachify.io", "eddy@brokerstaffer.com", "amy@brokerstaffer.com"];

export type CrmViewer =
  | { kind: "staff"; email: string }
  | { kind: "client"; email: string; portals: string[] };

/** May this signed-in address open this portal in the new design yet? */
export function openToClients(portalId: string | null | undefined, email: string | null | undefined): boolean {
  const who = (email ?? "").trim().toLowerCase();
  return isDemoPortal(portalId) && DEMO_CLIENT_TESTERS.includes(who);
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

/** How the data guard and the usage counts treat this viewer. */
export const guardRole = (v: CrmViewer) => (v.kind === "client" ? ("client" as const) : ("staff" as const));
