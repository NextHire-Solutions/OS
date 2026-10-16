/*
 * /crm-preview — the client's CRM redesign on a real client's data, for Owners.
 *
 * The client sent a redesign of their portal on 15 Oct. The user: "we do not
 * change our current client portals. first we need to see and experience this
 * for few clients but do not want to disturb the client portals for these
 * clients too" — and then: "make sure clients cannot see this and client
 * portals do not get broken. also not all team should see this. also do not
 * add this to product switch too under team access. only we should be able
 * to see this".
 *
 * So:
 *   - Owners only (ADMIN_EMAILS), and Eddy by name as its reviewer (16 Oct,
 *     the user's choice — access.ts). Anyone else gets Not found, the
 *     same as an address that does not exist; it is in no menu and on no Team
 *     access switch.
 *   - The OS only. Nothing here is served on portal.brokerstaffer.com, and the
 *     live portal's code, URLs, stages and leads are not touched.
 *   - Read-only. It reads what the live portal reads (portal-data.ts) and
 *     writes nothing; every button that would change something is shown
 *     disabled. The browser's one request is the portal's own read-only
 *     conversation feed.
 */

import type { Metadata } from "next";
import { Inter_Tight } from "next/font/google";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { SSO_COOKIE, verifySso } from "@/lib/bs-auth";
import { adminEmails } from "@/lib/identity/admin";
import { canSeeCrmPreview } from "@/lib/crm-preview/access";
import { furthestStages, PREVIEW_VIEWS, previewStages, type PreviewView } from "@/lib/crm-preview/model";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";
import { createAdminSupabase } from "@/lib/supabase/admin";
import {
  loadAgentEntries,
  loadDncEntries,
  loadPipelineEntries,
  loadTeamMembers,
} from "@/lib/tools/master-inbox/portals/portal-data";
import { loadClientStageRows } from "@/lib/tools/master-inbox/portals/load-stages";
import { canonicalStageDefs, MANAGE_STAGES_FLAG, resolveStageDefs } from "@/lib/tools/master-inbox/portals/stage-config";
import { clientHasFeature } from "@/lib/tools/master-inbox/portals/feature-flags";
import { CrmPreview } from "@/components/crm-preview/crm-preview";
import { clientForPortal, type OsClientRow } from "@/lib/crm-preview/market-model";
import { osTable } from "@/lib/clients/os-db";
import { ClientPicker } from "@/components/crm-preview/client-picker";
import { SessionKeeper } from "@/components/shell/session-keeper";

import "./crm-preview.css";
import "./preview.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Portal redesign preview",
  robots: { index: false, follow: false },
};

const interTight = Inter_Tight({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--crx-font", display: "swap" });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function CrmPreviewPage({ searchParams }: { searchParams: Search }) {
  const me = await verifySso(process.env.AUTH_SECRET ?? "", (await cookies()).get(SSO_COOKIE)?.value);
  if (!canSeeCrmPreview(me?.email, adminEmails())) notFound();

  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const clientId = one(params.client);
  const viewParam = one(params.view);
  const view: PreviewView = (PREVIEW_VIEWS as readonly string[]).includes(viewParam) ? (viewParam as PreviewView) : "pipeline";

  const admin = createAdminSupabase();
  const { data: portalRows } = await admin
    .from("clients")
    .select("id, name, slug, portal_token")
    .not("portal_token", "is", null)
    .order("name", { ascending: true });
  const portals = ((portalRows ?? []) as Array<{ id: string; name: string | null; slug: string | null }>)
    .filter((c) => c.slug !== "unknown")
    .map((c) => ({ id: c.id, name: c.name ?? "Unnamed client" }));

  // SessionKeeper renews the sign-in as the workspace does, so a long look at the preview doesn't end at the login page.
  const shell = (children: React.ReactNode) => (
    <div className={`crx-root cpv-shell ${interTight.variable}`}>
      {children}
      <SessionKeeper />
    </div>
  );

  if (!UUID.test(clientId)) return shell(<ClientPicker portals={portals} />);

  const { data: client } = await admin
    .from("clients")
    .select("id, name, slug, portal_token, stage_label_overrides, feature_flags, fub_api_key")
    .eq("id", clientId)
    .maybeSingle();
  if (!client || client.slug === "unknown" || !client.portal_token) return shell(<ClientPicker portals={portals} missing />);

  const rawFlags = (client as { feature_flags?: unknown }).feature_flags;
  const featureFlags = rawFlags && typeof rawFlags === "object" && !Array.isArray(rawFlags) ? (rawFlags as Record<string, unknown>) : {};
  const rawOverrides = (client as { stage_label_overrides?: unknown }).stage_label_overrides;
  const overrides = rawOverrides && typeof rawOverrides === "object" ? (rawOverrides as Record<string, unknown>) : {};
  const stageClient = { feature_flags: featureFlags, stage_label_overrides: overrides };

  // The client's stages exactly as their portal draws them (portal-detail.tsx).
  const manageStages = clientHasFeature({ feature_flags: featureFlags }, MANAGE_STAGES_FLAG);
  const defs = manageStages
    ? resolveStageDefs(stageClient, await loadClientStageRows(client.id as string))
    : canonicalStageDefs(stageClient);

  const [entries, agents, dnc, team, history, records] = await Promise.all([
    loadPipelineEntries(client.id as string),
    loadAgentEntries(client.id as string),
    loadDncEntries(client.id as string),
    loadTeamMembers(client.id as string),
    // The stage history the portal keeps (since 3 Aug), for where a tagged agent sits (model.ts placeEntry).
    fetchAllRows<{ entry_id: string | null; event_type: string }>(({ from, to }) =>
      admin.from("pipeline_outcome_events").select("entry_id, event_type").eq("client_id", client.id as string).eq("voided", false).order("id").range(from, to),
    ).catch((err) => {
      // Without the history a tagged agent sits at the first stage — shown, not hidden.
      console.error("[crm-preview] stage history", err);
      return [];
    }),
    // The client's record, for the person the design shows in the sidebar's footer.
    osTable("os_clients").select("id, name, aliases, mi_client_id, mls_codes, orch_client_id, contact_name").then((r) => (r.data ?? []) as unknown as Array<OsClientRow & { contact_name: string | null }>),
  ]);
  const record = clientForPortal({ id: client.id as string, name: (client.name as string | null) ?? "" }, records) as (OsClientRow & { contact_name: string | null }) | null;
  const stages = previewStages(defs);
  const tagKeys = new Set(stages.filter((s) => s.role === "tag").map((s) => s.key));
  const tagged = new Set(entries.filter((e) => tagKeys.has(e.custom_stage_key ?? e.stage)).map((e) => e.id));

  return shell(
    <CrmPreview
      client={{
        id: client.id as string,
        name: (client.name as string | null) ?? "Unnamed client",
        token: client.portal_token as string,
        // Whether a Follow Up Boss key is saved — never the key itself.
        fubConnected: Boolean((client as { fub_api_key?: string | null }).fub_api_key),
        contactName: record?.contact_name?.trim() || null,
      }}
      portals={portals}
      stages={stages}
      furthest={furthestStages(history, tagged)}
      entries={entries}
      agents={agents}
      dnc={dnc}
      team={team}
      initialView={view}
      now={new Date().toISOString()}
    />,
  );
}
