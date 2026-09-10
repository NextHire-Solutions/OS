/*
 * Portals — the tool's own admin screen.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACED A HAND-WRITTEN SCREEN
 *
 * This route used to render a 295-line screen of mine whose own comment said
 * "Read-only" — a table of the 47 portals with nothing you could do to them.
 * The tool's page mounts `PortalsAdmin`, 15KB of component with eight
 * interactions: enabling and disabling a portal, copying its link, rotating a
 * token, connecting Follow Up Boss, and opening each client.
 *
 * Nobody reported it, because a read-only table looks finished. It was found by
 * scripts/inbox-inventory.mjs, which lists every surface the tool has and
 * checks that the OS mounts the same components — this one mounted 0 of 2.
 */

import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { loadCombinedIntroSummaryByClient } from "@/lib/tools/master-inbox/portals/intro-leads";
import { PortalsAdmin } from "@/components/master-inbox/portals-ui/portals-admin";
import { CLIENT_PORTALS_ENABLED } from "@/lib/tools/master-inbox/portals/flag";
import { PortalsComingSoon } from "@/components/master-inbox/portals-ui/portals-coming-soon";

// Internal admin page — lists every client with its Introduction count and
// the controls to manage that client's public portal URL. Reached from the
// icon-rail "Client Portals" button.

export interface PortalClientRow {
  id: string;
  name: string;
  slug: string;
  portal_token: string | null;
  portal_enabled: boolean;
  intro_count: number;
  last_intro_at: string | null;
}

export async function PortalsAdminScreen() {
  await requireSession();

  // Feature-flagged off → show the placeholder and skip every query that
  // touches the portal_* columns (migration 0016 may not be applied yet).
  if (!CLIENT_PORTALS_ENABLED) return <PortalsComingSoon />;

  const admin = createAdminSupabase();
  const [{ data: clients }, summary] = await Promise.all([
    admin
      .from("clients")
      .select("id, name, slug, portal_token, portal_enabled")
      .neq("slug", "unknown")
      .order("name", { ascending: true }),
    loadCombinedIntroSummaryByClient(),
  ]);

  const rows: PortalClientRow[] = (clients ?? []).map((c) => {
    const s = summary.get(c.id as string);
    return {
      id: c.id as string,
      name: c.name as string,
      slug: c.slug as string,
      portal_token: (c.portal_token as string | null) ?? null,
      portal_enabled: (c.portal_enabled as boolean | null) ?? true,
      intro_count: s?.count ?? 0,
      last_intro_at: s?.lastAt ?? null,
    };
  });

  return <PortalsAdmin rows={rows} />;
}
