import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { loadPortalCounts } from "@/lib/tools/master-inbox/portals/portal-data";
import { publicPortalUrl } from "@/lib/tools/master-inbox/portals/public-url";
import { env } from "@/lib/env";

// GET /api/clients/portals
//
// Returns every client that has been added to MasterInbox AND has an
// active portal — `portal_enabled = true`, a non-empty portal_token,
// and the row is NOT the "unknown" fallback bucket. Each entry
// carries the metadata + per-portal counts you'd otherwise have to
// reassemble from /api/clients/intros + the admin /portals page.
//
// Auth: same model as /api/clients/intros — a normal user session OR
// `?token=<SUPABASE_SERVICE_ROLE_KEY>` / `x-admin-token: ...` for
// scripted callers. The service-role path also accepts an explicit
// `?workspace=<uuid>` (defaults to env.WORKSPACE_ID — the pinned
// singleton on production).
//
// The response intentionally NEVER ships raw secrets — `fub_api_key`
// is exposed as a boolean `fub_connected` plus the connect timestamp.
// Stage-label overrides + feature flags ride through verbatim so
// admin tooling can tell at a glance which clients have customised
// what.

export const dynamic = "force-dynamic";

interface PortalClientRow {
  id: string;
  name: string;
  slug: string;
  aliases: string[];
  portal_token: string;
  portal_url: string | null;
  portal_enabled: boolean;
  fub_connected: boolean;
  fub_connected_at: string | null;
  feature_flags: Record<string, unknown>;
  stage_label_overrides: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  counts: { pipeline: number; agents: number; dnc: number; team: number };
  // Most-recent updated_at across every lead (client_pipeline_entries row,
  // any stage) associated with this portal. Bumps on ANY modification —
  // including our own automation (new intros, FollowUp Boss push, "move
  // agent"). null when the portal has no leads.
  last_lead_activity_at: string | null;
  // Most-recent client_activity_at across the portal's leads — i.e. the
  // last time the CLIENT engaged (moved a lead, added a note, edited a
  // field). Excludes intro creation, FUB push, and move-agent, so this is
  // the field to show as "Portal Updated". null when the client has never
  // engaged (or before migration 0061 is applied). See migration 0061.
  last_client_activity_at: string | null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  const suppliedToken =
    url.searchParams.get("token") ?? request.headers.get("x-admin-token");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  let workspaceId: string;
  if (suppliedToken && serviceKey && suppliedToken === serviceKey) {
    workspaceId =
      url.searchParams.get("workspace") ?? env.WORKSPACE_ID ?? "";
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspace param required when using service-role token" },
        { status: 400 },
      );
    }
  } else {
    const userClient = await createServerSupabase();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const session = await requireSession();
    workspaceId = session.activeWorkspace.id;
  }

  const admin = createAdminSupabase();

  // Defensive SELECT: try the column list that includes the newer
  // optional columns (feature_flags, fub_*). If a migration is
  // lagging in some environment, fall back to the base column set
  // and synthesise empty values for the missing ones. Same pattern
  // resolvePortalClient uses — keeps the endpoint useful even
  // during a half-applied schema state.
  const SELECT_WITH_ALL =
    "id, name, slug, aliases, portal_token, portal_enabled, fub_api_key, fub_connected_at, feature_flags, stage_label_overrides, created_at, updated_at";
  const SELECT_BASE =
    "id, name, slug, aliases, portal_token, portal_enabled, created_at, updated_at";

  type FullRow = {
    id: string;
    name: string;
    slug: string;
    aliases: string[] | null;
    portal_token: string | null;
    portal_enabled: boolean | null;
    fub_api_key?: string | null;
    fub_connected_at?: string | null;
    feature_flags?: Record<string, unknown> | null;
    stage_label_overrides?: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  };

  let rows: FullRow[] | null = null;
  const first = await admin
    .from("clients")
    .select(SELECT_WITH_ALL)
    .neq("slug", "unknown")
    .eq("portal_enabled", true)
    .not("portal_token", "is", null)
    .order("name", { ascending: true });
  if (first.error) {
    const msg = (first.error.message ?? "").toLowerCase();
    const missingColumn =
      first.error.code === "42703" ||
      msg.includes("does not exist");
    if (!missingColumn) {
      return NextResponse.json({ error: first.error.message }, { status: 500 });
    }
    const retry = await admin
      .from("clients")
      .select(SELECT_BASE)
      .neq("slug", "unknown")
      .eq("portal_enabled", true)
      .not("portal_token", "is", null)
      .order("name", { ascending: true });
    if (retry.error) {
      return NextResponse.json({ error: retry.error.message }, { status: 500 });
    }
    rows = (retry.data ?? []) as FullRow[];
  } else {
    rows = (first.data ?? []) as FullRow[];
  }
  // `workspaceId` is part of the auth contract for parity with
  // /api/clients/intros — clients themselves are workspace-agnostic
  // in this single-tenant deployment, but we still surface the
  // resolved id in the response for caller-side observability.

  // client_activity_at exists only after migration 0061. Probe once so
  // the endpoint works before OR after it lands (no ordering dependency,
  // never 500s on a column-not-found); pre-migration we just report null.
  const clientActivityProbe = await admin
    .from("client_pipeline_entries")
    .select("client_activity_at")
    .limit(1);
  const hasClientActivity = !clientActivityProbe.error;

  // Fetch every client's counts in parallel. ~30 clients per
  // workspace today; loadPortalCounts is a single RPC per client.
  const enriched = await Promise.all(
    rows.map(async (row): Promise<PortalClientRow> => {
      // counts + last-lead-activity + last-client-activity in parallel.
      const [counts, lastLeadActivityAt, lastClientActivityAt] = await Promise.all([
        loadPortalCounts(row.id).catch((err) => {
          console.error("[clients/portals] counts failed for", row.id, err);
          return { pipeline: 0, agents: 0, dnc: 0, team: 0 };
        }),
        // MAX(updated_at) over the client's pipeline entries (all stages).
        // One indexed lookup per client; null when the portal has no leads.
        (async (): Promise<string | null> => {
          try {
            const { data } = await admin
              .from("client_pipeline_entries")
              .select("updated_at")
              .eq("client_id", row.id)
              .order("updated_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            return (data?.updated_at as string | null) ?? null;
          } catch (err) {
            console.error("[clients/portals] last activity failed for", row.id, err);
            return null;
          }
        })(),
        // MAX(client_activity_at) — last genuine client engagement. NULLS
        // LAST so an all-null client (never engaged) returns null, not a
        // stray row. Skipped (null) until migration 0061 adds the column.
        (async (): Promise<string | null> => {
          if (!hasClientActivity) return null;
          try {
            const { data } = await admin
              .from("client_pipeline_entries")
              .select("client_activity_at")
              .eq("client_id", row.id)
              .not("client_activity_at", "is", null)
              .order("client_activity_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            return (data?.client_activity_at as string | null) ?? null;
          } catch (err) {
            console.error("[clients/portals] client activity failed for", row.id, err);
            return null;
          }
        })(),
      ]);
      const rawOverrides = row.stage_label_overrides;
      const rawFlags = row.feature_flags;
      const fubKey = row.fub_api_key;
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        aliases: row.aliases ?? [],
        portal_token: row.portal_token ?? "",
        portal_url: publicPortalUrl(row.portal_token),
        portal_enabled: row.portal_enabled !== false,
        fub_connected:
          typeof fubKey === "string" && fubKey.trim().length > 0,
        fub_connected_at: row.fub_connected_at ?? null,
        feature_flags:
          rawFlags && typeof rawFlags === "object" && !Array.isArray(rawFlags)
            ? (rawFlags as Record<string, unknown>)
            : {},
        stage_label_overrides:
          rawOverrides &&
          typeof rawOverrides === "object" &&
          !Array.isArray(rawOverrides)
            ? (rawOverrides as Record<string, unknown>)
            : {},
        created_at: row.created_at,
        updated_at: row.updated_at,
        counts,
        last_lead_activity_at: lastLeadActivityAt,
        last_client_activity_at: lastClientActivityAt,
      };
    }),
  );

  return NextResponse.json({
    ok: true,
    workspace_id: workspaceId,
    count: enriched.length,
    clients: enriched,
  });
}
