import "server-only";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { adminEmails } from "@/lib/identity/admin";
import { PORTAL_COOKIE } from "@/lib/portal-login/http";
import { readSession } from "@/lib/portal-login/login";
import { createAdminSupabase } from "@/lib/supabase/admin";

import { canSeeCrmPreview } from "./access";
import { clientPortals, type CrmViewer } from "./viewer-rules";

/*
 * The one gate for the new portal's page and its routes (27 Oct; the rules
 * are in viewer-rules.ts). A staff reviewer's sign-in is looked at first, so
 * staff see exactly what they saw before. Otherwise a client's sign-in
 * (bs_portal), checked against the list on every request — an address taken
 * off the list loses access at once — and narrowed to the portals open to
 * clients. Null for anyone else: the caller answers Not found.
 */
export async function crmViewer(cookies: { sso: string | null | undefined; portal: string | null | undefined }, now = new Date()): Promise<CrmViewer | null> {
  const me = await verifySso(process.env.AUTH_SECRET ?? "", cookies.sso ?? undefined);
  if (me?.email && canSeeCrmPreview(me.email, adminEmails())) return { kind: "staff", email: me.email.trim().toLowerCase() };
  if (!cookies.portal) return null;
  const session = await readSession(createAdminSupabase(), cookies.portal, now).catch(() => null);
  if (!session) return null;
  const portals = clientPortals(session.portals);
  return portals.length ? { kind: "client", email: session.email, portals } : null;
}

/** For a route: both sign-ins from the request's cookies. */
export function crmViewerOf(request: { headers: { get(name: string): string | null }; cookies: { get(name: string): { value: string } | undefined } }): Promise<CrmViewer | null> {
  return crmViewer({ sso: readSsoCookie(request.headers.get("cookie")), portal: request.cookies.get(PORTAL_COOKIE)?.value });
}
