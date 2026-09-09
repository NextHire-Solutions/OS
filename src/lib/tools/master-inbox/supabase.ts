import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { NotConfiguredError } from "@/lib/env";

/*
 * Master Inbox's database.
 *
 * ---------------------------------------------------------------------------
 * WHY SERVICE ROLE, AND WHY THAT IS NOT A SHORTCUT
 *
 * Master Inbox binds its reads to the signed-in user through RLS: 51 files go
 * through `createServerSupabase()` and the policies resolve
 * `is_workspace_member(workspace_id)` against `auth.uid()`. An earlier plan
 * tried to reuse that by minting a Supabase session for our user, and the
 * failure mode was ugly — a session the policies reject returns ZERO ROWS with
 * no error, so the inbox renders empty and looks merely quiet.
 *
 * Reading with the service-role key sidesteps that entirely, and it is the same
 * thing the app already does for its most sensitive surface: the client portals
 * resolve through `createAdminSupabase()` too, gated by a token rather than by
 * RLS.
 *
 * The cost is that RLS stops being a safety net, so every query must scope by
 * `workspace_id` itself. `workspaceId()` below exists so no caller has to
 * remember. There is exactly one workspace today; that is not a reason to skip
 * the filter, it is a reason the filter is cheap.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY, DELIBERATELY
 *
 * Nothing in the workspace writes through this client, and that is a rule with
 * a specific reason rather than caution for its own sake. From the audit:
 *
 *   `client_pipeline_intro_label_trigger` creates a pipeline row when a thread
 *   is labelled — and that row appears in the client's LIVE portal.
 *
 * The triggers fire whoever writes, but the columns they depend on are set
 * correctly only by the code that knows about them. So writes go through
 * Master Inbox's own API, where its validation lives. See MASTER-INBOX-AUDIT.md.
 *
 * The credential needs no new secret: `MASTER_INBOX_ADMIN_TOKEN` already in the
 * workspace IS the service-role JWT, and its `ref` claim gives the project URL.
 * Both are stored explicitly so nothing has to decode a JWT to find them.
 */

let client: SupabaseClient | null = null;

export function getMasterInboxSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.MASTER_INBOX_SUPABASE_URL;
  const key =
    process.env.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY ??
    // The admin token is the same JWT. Accepted as a fallback so a partially
    // configured environment reads rather than fails.
    process.env.MASTER_INBOX_ADMIN_TOKEN;

  if (!url) throw new NotConfiguredError("MASTER_INBOX_SUPABASE_URL");
  if (!key) throw new NotConfiguredError("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY");

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      // Next's fetch caches aggressively by default. An inbox served from a
      // stale Data Cache entry would hide new mail, which is the one thing an
      // inbox must never do.
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });

  return client;
}

let cachedWorkspaceId: string | null = null;

/**
 * The workspace every query is scoped to.
 *
 * Resolved from the database rather than configured, so it cannot drift from
 * reality, and cached because it does not change. If a second workspace ever
 * appears this throws instead of silently picking one — mixing two workspaces'
 * mail together is the kind of bug that is discovered by a customer.
 */
export async function workspaceId(): Promise<string> {
  if (cachedWorkspaceId) return cachedWorkspaceId;

  const { data, error } = await getMasterInboxSupabase()
    .from("workspaces")
    .select("id")
    .limit(2);

  if (error) throw new Error(`Could not resolve the workspace: ${error.message}`);
  const rows = Array.isArray(data) ? (data as { id: string }[]) : [];
  if (rows.length === 0) throw new Error("Master Inbox has no workspace");
  if (rows.length > 1) {
    throw new Error(
      "Master Inbox now has more than one workspace — the inbox must be told which one to show",
    );
  }

  cachedWorkspaceId = String(rows[0].id);
  return cachedWorkspaceId;
}
