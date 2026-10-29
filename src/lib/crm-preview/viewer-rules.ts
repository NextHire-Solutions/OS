/*
 * Who is looking at the new portal, which portals they may open, and which they may change (27–29 Oct).
 *
 * STAFF — the preview's reviewers (access.ts: Owners, Eddy, Amy, by name) — open ANY portal and change it (29 Oct,
 * the user: "me, eddy and amy … should be able to see all the client portals and make actions there"). On a real
 * portal a staff save is the client's own save — the current portal's code, with everything it sets off
 * (portal-save.ts) — made and logged in the staff member's name.
 *
 * A CLIENT — someone signed in at /portal-signin (lib/portal-login) — opens only the portals their address is on
 * the sign-in list for, and changes their own records there, as their current portal does.
 *
 * THE CLIENT LAUNCH (29 Oct, the user: "switch on the new client portals … clients too"): one switch,
 * OS_CLIENT_SIGNIN — the same one that lets the sign-in email reach a client (portal-login/mail.ts). On: every real
 * portal opens to the addresses on its own sign-in list. Off (as before the launch): a real portal opens only to the
 * named testers, and no client receives a sign-in email. Either way the Demo opens only to the testers, and every
 * client's current portal (portal.brokerstaffer.com) is untouched.
 */

import { isDemoPortal } from "./demo.ts";

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

/** BrokerStaffer's own portal (Master Inbox `clients`) — the house account, never counted as a client. One id: market-model.ts. */
export { BROKERSTAFFER_PORTAL_ID } from "./market-model.ts";

/* The client launch switch (portal-login/mail.ts SIGNIN_ENV — viewer-rules.test.ts keeps the two the same name). */
export const CLIENT_LAUNCH_ENV = "OS_CLIENT_SIGNIN";
/** Is the new portal open to clients (their sign-in lists) — the launch switch exactly "1"? */
export function clientsOn(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[CLIENT_LAUNCH_ENV]?.trim() === "1";
}

/*
 * How a portal opens to someone signed in as a client:
 *   "testers"  only DEMO_CLIENT_TESTERS (and only while their address is on the portal's sign-in list)
 *   "listed"   every address on the portal's sign-in list
 * The Demo: testers, always. A real portal: listed once clients are on; testers until then.
 */
export type OpenRule = "testers" | "listed";
export function openRule(portalId: string | null | undefined, env: Readonly<Record<string, string | undefined>> = process.env): OpenRule | undefined {
  if (!portalId) return undefined;
  if (isDemoPortal(portalId)) return "testers";
  return clientsOn(env) ? "listed" : "testers";
}

export type CrmViewer =
  | { kind: "staff"; email: string }
  | { kind: "client"; email: string; portals: string[] };

/** Does a portal open this way let this address in? (Pure — openRule says which way each portal opens.) */
export function opensTo(rule: OpenRule | undefined, email: string | null | undefined): boolean {
  const who = (email ?? "").trim().toLowerCase();
  if (rule === "listed") return who.length > 0;
  return rule === "testers" && DEMO_CLIENT_TESTERS.includes(who);
}

/** May this signed-in address open this portal in the new design yet? */
export function openToClients(portalId: string | null | undefined, email: string | null | undefined): boolean {
  return opensTo(openRule(portalId), email);
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
 * May this viewer CHANGE this portal from the new design? Whoever may open it: the Demo Portal's viewers (its saves
 * are its own rows, nothing outside — demo.ts); a real portal's own signed-in client; and staff, on any portal
 * (29 Oct — on a real portal through its current save code, portal-save.ts, in their own name).
 */
export function mayWritePortal(v: CrmViewer | null, portalId: string | null | undefined): boolean {
  return mayOpenPortal(v, portalId);
}

/** How the data guard and the usage counts treat this viewer. */
export const guardRole = (v: CrmViewer) => (v.kind === "client" ? ("client" as const) : ("staff" as const));
