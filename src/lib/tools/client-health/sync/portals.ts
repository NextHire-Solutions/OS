// Corofy portals API client — surfaces which clients have an active
// portal in the Corofy / MasterInbox system.
//
// Auth: same `x-admin-token` header as listCorofyIntros, but the token
// here is the Corofy app's Supabase service-role JWT, not the BrokerStaffer
// one. Both happen to be served by the same Railway deployment, just
// different routes.
//
// ---------------------------------------------------------------------------
// PORTED from the tool's lib/portals.ts (eb7d572), WITH ONE ROUTING CHANGE
//
// "Corofy" is the deployed Master Inbox, and the workspace now hosts Master
// Inbox's own `GET /api/clients/portals` handler at
// `src/app/api/tools/master-inbox/clients/portals/route.ts` — the same file,
// against the same database. So when Master Inbox is configured in this
// process, the handler is CALLED DIRECTLY, in-process, with the same
// `x-admin-token` + `?workspace=` contract it already honours for scripted
// callers. No network hop, no dependency on the Corofy deployment staying up,
// and exactly the response shape the tool parsed.
//
// When Master Inbox is NOT configured here, the tool's external call is made
// unchanged, so a half-configured environment degrades to what the tool did
// rather than to nothing.
//
// Either way the contract from the tool survives: any failure returns [] and
// the caller leaves portal_active alone.

import { optionalEnv } from "@/lib/env";

export interface CorofyPortal {
  id: string;
  name: string;
  slug: string;
  aliases?: string[];
  portal_token: string;
  portal_url: string;
  portal_enabled: boolean;
  fub_connected: boolean;
  fub_connected_at: string | null;
  counts?: { pipeline: number; dnc: number; agents: number; team: number };
  created_at: string;
  updated_at: string;
  // Most recent updated_at across every lead in the portal (any stage).
  // Kept for backward-compat; superseded by last_client_activity_at.
  last_lead_activity_at?: string | null;
  // Most recent CLIENT-DRIVEN action across every lead in the portal.
  // Excludes our-side automation (FUB auto-push, move-agent, sync, new
  // intro assignment). Null when no client has ever acted on any lead.
  // This is the field we surface as "Portal Updated" in the UI.
  last_client_activity_at?: string | null;
}

interface CorofyPortalsResp {
  ok: boolean;
  workspace_id: string;
  count: number;
  clients: CorofyPortal[];
}

/**
 * Where the portals list will come from, given the environment.
 *
 *   "master-inbox"  the workspace's own route, in-process
 *   "corofy"        the tool's external call to CLIENT_HEALTH_COROFY_BASE_URL
 *   null            neither is configured — the tool returned [] here too
 *
 * A pure function of the env so the decision is testable without a request.
 */
export function portalsSource(
  env: (name: string) => string | undefined = optionalEnv,
): "master-inbox" | "corofy" | null {
  if (env("MASTER_INBOX_SUPABASE_URL") && env("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY")) {
    return "master-inbox";
  }
  if (env("CLIENT_HEALTH_COROFY_BASE_URL") && env("CLIENT_HEALTH_COROFY_ADMIN_TOKEN")) {
    return "corofy";
  }
  return null;
}

async function fromMasterInbox(): Promise<CorofyPortal[]> {
  // Loaded lazily: the route pulls in next/headers and the Master Inbox
  // Supabase client, none of which a unit test of the Corofy path should
  // have to load. The service-role token is what the route compares against
  // (`env.SUPABASE_SERVICE_ROLE_KEY`), and the workspace id is the pinned
  // singleton when set, else resolved from the database exactly as every
  // other Master Inbox loader in this workspace resolves it.
  const [{ GET }, { workspaceId }] = await Promise.all([
    import("@/app/api/tools/master-inbox/clients/portals/route"),
    import("@/lib/tools/master-inbox/supabase"),
  ]);
  const token = optionalEnv("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY")!;
  const workspace =
    optionalEnv("MASTER_INBOX_WORKSPACE_ID") ??
    optionalEnv("MASTER_INBOX_COROFY_WORKSPACE_ID") ??
    (await workspaceId());
  const url = new URL("http://client-health.internal/api/tools/master-inbox/clients/portals");
  url.searchParams.set("workspace", workspace);
  const res = await GET(new Request(url, { headers: { "x-admin-token": token, Accept: "application/json" } }));
  if (!res.ok) return [];
  const json = (await res.json()) as CorofyPortalsResp;
  return json?.clients ?? [];
}

async function fromCorofy(): Promise<CorofyPortal[]> {
  const BASE = (optionalEnv('CLIENT_HEALTH_COROFY_BASE_URL') ?? '').replace(/\/$/, '');
  const token = optionalEnv('CLIENT_HEALTH_COROFY_ADMIN_TOKEN');
  if (!BASE || !token) return [];
  const res = await fetch(`${BASE}/api/clients/portals`, {
    headers: {
      'x-admin-token': token,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) return [];
  const json = (await res.json()) as CorofyPortalsResp;
  return json?.clients ?? [];
}

export async function listCorofyPortals(): Promise<CorofyPortal[]> {
  const source = portalsSource();
  if (!source) return [];
  try {
    return source === "master-inbox" ? await fromMasterInbox() : await fromCorofy();
  } catch {
    // Network/parse error — degrade gracefully (portalActive flag will be
    // false for every client this load; next load may recover).
    return [];
  }
}
