import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { createAdminSupabase } from "@/lib/supabase/admin";

import { personName, teamName } from "./signed-in";
import type { CrmViewer } from "./viewer-rules";

/*
 * Who is signed in, for the design's "you" (signed-in.ts — 29 Oct; it showed the client record's contact). Called only
 * after the caller's gate has passed: it reads.
 */
export async function signedInPerson(viewer: CrmViewer, portalId: string, team: ReadonlyArray<{ name: string | null; email: string | null }>): Promise<{ name: string; email: string }> {
  const email = viewer.email.trim().toLowerCase();
  const onTeam = teamName(email, team);
  if (onTeam) return { name: onTeam, email };
  if (viewer.kind === "client") {
    const { data } = await createAdminSupabase().from("os_portal_logins").select("name").eq("portal_id", portalId).eq("email", email).is("removed_at", null).maybeSingle();
    return { name: personName(email, { listed: (data as { name: string | null } | null)?.name }), email };
  }
  const { data } = await osTable("os_users").select("name").eq("email", email).maybeSingle();
  return { name: personName(email, { account: (data as { name: string | null } | null)?.name }), email };
}
