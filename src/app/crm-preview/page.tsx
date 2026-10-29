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
 *   - Staff (the reviewers) open and CHANGE every client's portal here (29 Oct, the user: "me, eddy and amy …
 *     should be able to see all the client portals and make actions there"): on a real portal a save is the
 *     client's own — that portal's current save code (portal-save.ts) — in the staff member's name, and the bar
 *     says LIVE. The browser asks only the preview's own routes (api/crm-preview) — never with a portal's token,
 *     which stays on the server (21 Oct: a token alone opens that client's live portal).
 *   - And CLIENTS (27 Oct, the user's Option B): someone signed in at /portal-signin opens their own portal here,
 *     as a client sees it — no preview bar, no other clients. Which portals open to clients is one switch,
 *     OS_CLIENT_SIGNIN (viewer-rules.ts): on, every real portal to the addresses on its own sign-in list; off,
 *     only to the named testers. The Demo is the testers' alone. Every client's current portal
 *     (portal.brokerstaffer.com) is untouched either way.
 *   - Such a client sees what their current portal would: nothing while it is switched off, and only the
 *     "paused" notice while it is held for an unpaid invoice.
 */

import type { Metadata } from "next";
import localFont from "next/font/local";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { after } from "next/server";

import { SSO_COOKIE } from "@/lib/bs-auth";
import { PORTAL_COOKIE } from "@/lib/portal-login/http";
import { crmViewer } from "@/lib/crm-preview/viewer";
import { mayOpenPortal, mayWritePortal, type CrmViewer } from "@/lib/crm-preview/viewer-rules";
import type { TeamMember } from "@/lib/tools/master-inbox/portals/stages-shared";
import { personName, teamName } from "@/lib/crm-preview/signed-in";
import { furthestStages, managedStages, PREVIEW_VIEWS, previewStages, type PortalOffer, type PreviewView } from "@/lib/crm-preview/model";
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
import { isDemoPortal } from "@/lib/crm-preview/demo";
import { warmPortalMarket } from "@/lib/crm-preview/market";
import { osTable } from "@/lib/clients/os-db";
import { CLIENT_PORTALS_ENABLED } from "@/lib/tools/master-inbox/portals/flag";
import { portalBillingHold } from "@/lib/tools/master-inbox/portals/billing-hold";
import { PortalBillingHold } from "@/components/master-inbox/portals-ui/billing-hold";
import { ClientPicker } from "@/components/crm-preview/client-picker";
import { SessionKeeper } from "@/components/shell/session-keeper";

import "./crm-preview.css";
import "./preview.css";
import "./mobile.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "BrokerStaffer",
  robots: { index: false, follow: false },
};

/*
 * The design's own font files (the handoff's assets/fonts: Inter Tight 400, 500
 * and 600, the only weights it uses), so every letter is the one the client
 * drew with — not a newer cut of the family from Google.
 */
const interTight = localFont({
  src: [
    { path: "./fonts/inter-tight-latin-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/inter-tight-latin-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/inter-tight-latin-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--crx-font",
  display: "swap",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Search = Promise<Record<string, string | string[] | undefined>>;

/* A portal's saved offer (migration 0039); none yet — or the table not there yet — is null, never an error. */
async function loadOffer(portalId: string): Promise<PortalOffer | null> {
  const { data, error } = await createAdminSupabase().from("os_portal_offers").select("offers, why_join, never_say, updated_at").eq("portal_id", portalId).maybeSingle();
  if (error || !data) return null;
  const r = data as { offers: string[] | null; why_join: string; never_say: string | null; updated_at: string | null };
  return { offers: r.offers ?? [], whyJoin: r.why_join, neverSay: r.never_say, updatedAt: r.updated_at };
}

export default async function CrmPreviewPage({ searchParams }: { searchParams: Search }) {
  const jar = await cookies();
  // Staff (the reviewers) first, else a client's sign-in, narrowed to the portals open to clients — anyone else: Not found.
  const viewer = await crmViewer({ sso: jar.get(SSO_COOKIE)?.value, portal: jar.get(PORTAL_COOKIE)?.value });
  if (!viewer) notFound();
  const audience = viewer.kind;

  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const viewParam = one(params.view);
  // The Setup wizard's step (1–6).
  const stepParam = Math.floor(Number(one(params.step)));
  const step = stepParam >= 1 && stepParam <= 6 ? stepParam : 1;

  const admin = createAdminSupabase();
  // Staff: every portal. A client: only their own, open to clients.
  let portalQuery = admin.from("clients").select("id, name, slug, portal_token, portal_enabled").not("portal_token", "is", null);
  if (viewer.kind === "client") portalQuery = portalQuery.in("id", viewer.portals);
  const { data: portalRows } = await portalQuery.order("name", { ascending: true });
  const portals = ((portalRows ?? []) as Array<{ id: string; name: string | null; slug: string | null; portal_enabled: boolean | null }>)
    .filter((c) => c.slug !== "unknown")
    // Staff are told which is the practice portal and which the client cannot open (switched off) — never a client.
    .map((c) => ({ id: c.id, name: c.name ?? "Unnamed client", note: viewer.kind !== "staff" ? undefined : isDemoPortal(c.id) ? "Practice — saves stay in the Demo" : c.portal_enabled === false ? "Switched off — the client can't open it" : undefined }));
  // A client with one portal goes straight to it.
  const clientId = one(params.client) || (viewer.kind === "client" && portals.length === 1 ? portals[0].id : "");

  // SessionKeeper renews a STAFF sign-in as the workspace does (its 401 sends to the staff login — never for a client, whose sign-in lasts 30 days).
  const shell = (children: React.ReactNode) => (
    <div className={`crx-root cpv-shell${audience === "client" ? " cpv-client" : ""} ${interTight.variable}`}>
      {children}
      {audience === "staff" ? <SessionKeeper /> : null}
    </div>
  );

  if (!UUID.test(clientId)) return shell(<ClientPicker portals={portals} audience={audience} />);
  // Not one of theirs (a client) — Not found, as for an address that does not exist.
  if (!mayOpenPortal(viewer, clientId)) notFound();
  // A client's market starts loading now, after the page is sent, so the wizard's market steps answer at once (market.ts warmPortalMarket).
  if (audience === "client") after(() => warmPortalMarket(clientId).catch((e) => console.error("[crm-preview] warm", e instanceof Error ? e.message : e)));

  const { data: client } = await admin
    .from("clients")
    .select("id, name, slug, portal_token, portal_enabled, stage_label_overrides, feature_flags, fub_api_key")
    .eq("id", clientId)
    .maybeSingle();
  if (!client || client.slug === "unknown" || !client.portal_token) return shell(<ClientPicker portals={portals} missing audience={audience} />);
  // (The Demo Portal is the testers' sample, no client's: it stays open — portal-open.ts.)
  if (audience === "client" && !isDemoPortal(client.id as string)) {
    // A client sees what their current portal would show (Master Inbox app/portal/[token]/layout.tsx): nothing while portals are off or theirs is switched off …
    if (!CLIENT_PORTALS_ENABLED || (client as { portal_enabled?: boolean | null }).portal_enabled === false) notFound();
    // … and only the notice while it is held for an unpaid invoice (billing-hold.ts — fails open). Staff still see the portal.
    const hold = await portalBillingHold(client.id as string);
    if (hold) return <PortalBillingHold clientName={(client.name as string | null) ?? "Your portal"} hold={hold} />;
  }

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
    osTable("os_clients").select("id, name, aliases, mi_client_id, mls_codes, orch_client_id, contact_name, areas").then((r) => (r.data ?? []) as unknown as Array<OsClientRow & { contact_name: string | null; areas: string[] | null }>),
  ]);
  const record = clientForPortal({ id: client.id as string, name: (client.name as string | null) ?? "" }, records) as (OsClientRow & { contact_name: string | null; areas: string[] | null }) | null;
  const stages = previewStages(defs);
  const tagKeys = new Set(stages.filter((s) => s.role === "tag").map((s) => s.key));
  const tagged = new Set(entries.filter((e) => tagKeys.has(e.custom_stage_key ?? e.stage)).map((e) => e.id));
  /*
   * Staff on a real portal its own save code would refuse (29 Oct audit): switched off, client portals off, or held for an
   * unpaid invoice (portal-save.ts openPortal / billing hold). Shown read-only, saying why — never LIVE with every save
   * refused. A client never gets this far on such a portal (above).
   */
  const locked = audience === "staff" && !isDemoPortal(client.id as string)
    ? !CLIENT_PORTALS_ENABLED
      ? "Client portals are switched off — nothing here can be saved"
      : (client as { portal_enabled?: boolean | null }).portal_enabled === false
        ? `Switched off — ${(client.name as string | null) ?? "this client"} can't open it, and it can't be changed until it is switched on`
        : (await portalBillingHold(client.id as string))
          ? "Paused for an unpaid invoice — nothing can be changed (the client sees only the paused notice)"
          : null
    : null;
  // Who may change this portal from here (viewer-rules.ts): whoever may open it — the staff reviewers on every portal (29 Oct) — unless locked.
  const editable = mayWritePortal(viewer, client.id as string) && !locked;
  // The wizard's "Tell us your offer", as saved (0039) — every portal; null: not told yet. And who is signed in.
  const [offer, you] = await Promise.all([loadOffer(client.id as string), signedInPerson(viewer, client.id as string, team)]);
  // A client's first look opens the Setup wizard (their offer not told yet) — the design's "first sign-in"; staff open it from the preview bar.
  const view: PreviewView = (PREVIEW_VIEWS as readonly string[]).includes(viewParam)
    ? (viewParam as PreviewView)
    : audience === "client" && offer === null ? "setup" : "pipeline";

  return shell(
    <CrmPreview
      client={{
        id: client.id as string,
        name: (client.name as string | null) ?? "Unnamed client",
        demo: isDemoPortal(client.id as string),
        // Whether a Follow Up Boss key is saved — never the key itself.
        fubConnected: Boolean((client as { fub_api_key?: string | null }).fub_api_key),
        // The signed-in person, never the record's contact (29 Oct).
        contactName: you.name,
        youEmail: you.email,
        // What the record covers, for the Setup wizard's welcome line: its areas, else its MLS.
        coverage: (record?.areas ?? []).filter(Boolean).join(", ") || (record?.mls_codes ?? []).filter(Boolean).join(", ") || null,
      }}
      portals={portals}
      stages={stages}
      // Every stage, hidden ones too — only where Manage stages saves (a portal this viewer may change, with manage_stages); otherwise the panel is drawn from `stages`.
      allStages={editable && manageStages ? managedStages(defs) : undefined}
      // The wizard's "Tell us your offer", as saved (0039).
      offer={offer}
      editable={editable}
      locked={locked}
      audience={audience}
      furthest={furthestStages(history, tagged)}
      entries={entries}
      agents={agents}
      dnc={dnc}
      team={team}
      initialView={view}
      initialStep={step}
      now={new Date().toISOString()}
    />,
  );
}

/*
 * Who is signed in, for the design's "you" (signed-in.ts — 29 Oct; it showed the client record's contact). Kept below
 * the page: it reads only after the page's gate has passed (access.test.ts checks the order in this file).
 */
async function signedInPerson(viewer: CrmViewer, portalId: string, team: TeamMember[]): Promise<{ name: string; email: string }> {
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
