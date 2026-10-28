import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { portalBillingHold } from "@/lib/tools/master-inbox/portals/billing-hold";
import { CLIENT_PORTALS_ENABLED } from "@/lib/tools/master-inbox/portals/flag";

import { isDemoPortal } from "./demo";
import type { CrmViewer } from "./viewer-rules";

/**
 * Whether a CLIENT's portal is closed to them right now, as their current portal decides (Master Inbox
 * lib/portals/token.ts: "every portal page and API gates on this, so a held portal serves no data"): portals switched
 * off, theirs switched off (or not readable — closed, as there), or held for an unpaid invoice (billing-hold.ts, which
 * fails open, as there). The page shows the notice or Not found; every data route answers a bare 404 (28 Oct audit).
 *
 * Staff are never refused here (they see every portal; on one that is off or held the page shows it read-only, saying
 * why — page.tsx `locked`, 29 Oct), and the Demo Portal — the testers' sample, no client's — stays open.
 */
export async function closedToClient(viewer: CrmViewer, portalId: string): Promise<"off" | "held" | null> {
  if (viewer.kind !== "client" || isDemoPortal(portalId)) return null;
  if (!CLIENT_PORTALS_ENABLED) return "off";
  const { data, error } = await createAdminSupabase().from("clients").select("portal_enabled, slug").eq("id", portalId).maybeSingle();
  const row = data as { portal_enabled: boolean | null; slug: string | null } | null;
  if (error || !row || row.portal_enabled === false || row.slug === "unknown") return "off";
  return (await portalBillingHold(portalId)) ? "held" : null;
}
