import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/*
 * Client Health's database.
 *
 * Copied from the tool, with one change: the environment variables are
 * NAMESPACED. Five tools are moving into this codebase and every one of them
 * calls its database `SUPABASE_URL` — unprefixed, they would collide and each
 * tool would silently read whichever project happened to win.
 *
 * MERGED INTO THE MASTER INBOX PROJECT (Nov 2026, to close Client Health's own Supabase project). With
 * CLIENT_HEALTH_DB=master-inbox the same six tables are read and written in the Master Inbox project's own schema,
 * `client_health` (migrations/0057_client_health_schema.sql; the schema must also be listed in that project's exposed
 * schemas), with the Master Inbox URL and service key — the ones os-db.ts uses. Without the setting: Client Health's
 * own project, as before (CLIENT_HEALTH_SUPABASE_URL / _SERVICE_ROLE_KEY). Rolling back = removing the setting. Every
 * Client Health read and write in the OS goes through getSupabase(), so this one switch moves all of them together.
 */

export const CLIENT_HEALTH_SCHEMA = "client_health";

/** True once Client Health's tables live in the Master Inbox project (CLIENT_HEALTH_DB=master-inbox). */
export function clientHealthInMasterInbox(): boolean {
  return (process.env.CLIENT_HEALTH_DB ?? "").trim().toLowerCase() === "master-inbox";
}

/** The settings Client Health's database needs, for "is it configured" checks and their messages. */
export function clientHealthDbEnv(): string[] {
  return clientHealthInMasterInbox()
    ? ["MASTER_INBOX_SUPABASE_URL", "MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY"]
    : ["CLIENT_HEALTH_SUPABASE_URL", "CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY"];
}

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;

  if (clientHealthInMasterInbox()) {
    const url = process.env.MASTER_INBOX_SUPABASE_URL;
    const key = process.env.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY ?? process.env.MASTER_INBOX_ADMIN_TOKEN;
    if (!url || !key) {
      throw new Error(
        "CLIENT_HEALTH_DB=master-inbox needs MASTER_INBOX_SUPABASE_URL and MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    cached = createClient(url, key, {
      db: { schema: CLIENT_HEALTH_SCHEMA },
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as SupabaseClient;
    return cached;
  }

  const url = process.env.CLIENT_HEALTH_SUPABASE_URL;
  const key = process.env.CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "CLIENT_HEALTH_SUPABASE_URL and CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY must be set.",
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
