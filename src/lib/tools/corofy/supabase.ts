import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { NotConfiguredError } from "@/lib/env";

/*
 * The database Agent Search and Onboarding share.
 *
 * ---------------------------------------------------------------------------
 * THEY ARE ONE PROJECT
 *
 * Both Railway services point at the same Supabase URL. It was not obvious
 * from either codebase — each reads a plain `SUPABASE_URL` and neither
 * mentions the other — so it is worth stating here, because it changes what a
 * migration on "the onboarding database" can safely touch.
 *
 * The two halves are cleanly separated by prefix:
 *
 *   orch_*                    Onboarding — clients, stages, introductions
 *   agents, offices, mls,     Agent Search — 1.17M agents, 1.33M agent↔MLS
 *   agent_mls, saved_lists    links, 178K offices, 54 MLS boards
 *
 * One client rather than two: two would open two connection pools to the same
 * Postgres for no benefit.
 *
 * ---------------------------------------------------------------------------
 * SCALE
 *
 * `agents` has over a million rows and `agent_mls` more. Nothing here may read
 * a whole table. Every agent query goes through the database's own RPCs
 * (fn_agent_page_ids, fn_filter_search, fn_facet_options) — the same ones the
 * live tool uses, which exist precisely because a naive select would time out.
 *
 * Read-only. The scraping workers, the MLS monitor and Onboarding's five
 * webhook handlers keep writing; the workspace only reads what they produce.
 */

let client: SupabaseClient | null = null;

export function getCorofySupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.AGENT_SEARCH_SUPABASE_URL;
  const key = process.env.AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new NotConfiguredError("AGENT_SEARCH_SUPABASE_URL");
  if (!key) throw new NotConfiguredError("AGENT_SEARCH_SUPABASE_SERVICE_ROLE_KEY");

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      // Next's fetch caches aggressively by default. These reads back live
      // operational screens and must never come from a stale Data Cache entry.
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });

  return client;
}

/**
 * The number of rows matching a query, without fetching them.
 *
 * PostgREST returns this in the Content-Range header when asked for an exact
 * count and a zero-length range, so counting a million-row table costs one
 * round trip and no rows.
 */
export async function countRows(table: string): Promise<number | null> {
  const { count, error } = await getCorofySupabase()
    .from(table)
    .select("*", { count: "exact", head: true });
  return error ? null : (count ?? null);
}
