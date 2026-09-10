import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getCorofySupabase } from "../corofy/supabase";
import { ReadOnlyTableError, WRITE_METHODS, isWritable } from "./write-guard";

export { ReadOnlyTableError, isWritable } from "./write-guard";

/*
 * The onboarding orchestrator's database handle — with the tool's own guard.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN CALLING getCorofySupabase() DIRECTLY
 *
 * Onboarding and Agent Search share ONE Supabase project (see
 * ../corofy/supabase.ts). Onboarding owns the `orch_*` tables; Agent Search
 * owns `agents` (1.17M rows), `agent_mls`, `offices`, `mls` and `saved_lists`.
 * The service-role key can write all of them.
 *
 * The live orchestrator does not rely on being careful. Its `lib/supabase.ts`
 * wraps the client so that any insert/update/upsert/delete against a table not
 * prefixed `orch_` throws BEFORE the network call. Until now the workspace only
 * ever read from this database, so it did not need the guard. These screens
 * write — stages, templates, settings, the roster — so the guard comes with
 * them. This is that code, ported: same prefix, same methods, same behaviour.
 *
 * Reads are unaffected on every table; only writes outside `orch_*` are
 * refused. A mistyped table name in a future edit now fails loudly here rather
 * than quietly mutating a million scraped agent rows.
 */

function guardedFrom(client: SupabaseClient, table: string) {
  const builder = client.from(table);
  if (isWritable(table)) return builder; // our own tables: full access

  // Scraped/foreign tables: reads pass through, writes throw.
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && WRITE_METHODS.has(prop)) {
        return () => {
          throw new ReadOnlyTableError(table, prop);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The shared Corofy client, with writes confined to `orch_*`.
 *
 * Wrapped per call rather than cached: `getCorofySupabase()` already memoises
 * the underlying client, and the proxy is a few object allocations.
 */
export function getOnboardingDb(): SupabaseClient {
  const client = getCorofySupabase();
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "from") return (table: string) => guardedFrom(target, table);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SupabaseClient;
}
