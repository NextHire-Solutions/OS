import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/*
 * Client Health's own Supabase project.
 *
 * Copied from the tool, with one change: the environment variables are
 * NAMESPACED. Five tools are moving into this codebase and every one of them
 * calls its database `SUPABASE_URL` — unprefixed, they would collide and each
 * tool would silently read whichever project happened to win.
 *
 * Same project, same service key, same tables as the live app. The tool keeps
 * running untouched; this simply talks to the same database it does.
 */

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;

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
