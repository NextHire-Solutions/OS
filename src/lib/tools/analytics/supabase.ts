import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { NotConfiguredError } from "@/lib/env";

/*
 * Campaign Analytics' database, read directly.
 *
 * This is the ONE file not copied verbatim from the tool. Its own version
 * reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — unprefixed names that
 * would collide with Client Health's, since the workspace talks to four
 * separate Supabase projects in a single process. Namespacing them is the
 * whole change; the credential and the connection are the tool's.
 *
 * Service-role, exactly as the tool uses it. That is not a downgrade in
 * security here: Analytics has no browser client and no anon key, so RLS was
 * never load-bearing for it. Reads reach the browser only through this app's
 * own server, behind the workspace sign-in.
 *
 * The live Analytics app keeps running untouched against this same database.
 * Everything here is read-only, so a bug in the workspace cannot corrupt what
 * the tool's scheduler writes.
 *
 * Constructed lazily so a missing variable fails the request that needed the
 * database — with the variable's name in the message — rather than at import
 * time, which would take the whole workspace down.
 */

let client: SupabaseClient | null = null;

export function getAnalyticsSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.ANALYTICS_SUPABASE_URL;
  const key = process.env.ANALYTICS_SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new NotConfiguredError("ANALYTICS_SUPABASE_URL");
  if (!key) throw new NotConfiguredError("ANALYTICS_SUPABASE_SERVICE_ROLE_KEY");

  client = createClient(url, key, {
    auth: {
      // A machine credential — there are no user sessions on this client.
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      fetch: (input, init) =>
        // Next's fetch caches aggressively by default; analytics reads must
        // never be served from a stale Data Cache entry.
        fetch(input, { ...init, cache: "no-store" }),
    },
  });

  return client;
}

/** The EmailBison team whose data this workspace reports on. */
export function analyticsTeamId(): number {
  return Number(process.env.ANALYTICS_TEAM_ID || 2);
}

/**
 * PostgREST caps result sets at 1000 rows and TRUNCATES SILENTLY — `.range()`
 * can only shrink that, never raise it. Any full-table read must page.
 *
 * Copied from the tool unchanged. Aggregation happens in SQL RPCs, so this is
 * rarely needed, but a silent truncation would be invisible in the output.
 */
export async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;

    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return all;
}
