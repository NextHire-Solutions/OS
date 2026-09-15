import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { NotConfiguredError } from "@/lib/env";
import { NotAnOsTableError, isOsTable, OS_TABLES, type OsTable } from "./os-tables";

export { NotAnOsTableError, OS_TABLES };
export type { OsTable };

/*
 * The OS's own tables, inside Master Inbox's database.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE CLIENT
 *
 * `lib/tools/master-inbox/supabase.ts` is READ-ONLY by rule, and the rule has a
 * specific reason: Master Inbox's tables carry triggers that reach the outside
 * world. `client_pipeline_intro_label_trigger` creates a pipeline row when a
 * thread is labelled, and that row appears in a customer's LIVE portal. The
 * triggers fire for whoever writes, but the columns they depend on are set
 * correctly only by the code that knows about them — so writes go through
 * Master Inbox's own API, where its validation lives.
 *
 * `os_clients` and `os_client_onboarding` are different: new tables, no
 * triggers, owned by the workspace, read by nothing else. Writing to them is
 * safe in a way that writing to `clients` or `threads` is not.
 *
 * The danger is that the DIFFERENCE is invisible at the call site. A client
 * that can write to our two tables can write to all 40 of Master Inbox's, and
 * the only thing standing between the two is whoever is typing. So this module
 * refuses by default and allows exactly two names.
 *
 * That is not paperwork. A stray `.from("clients").update(...)` here would edit
 * the table holding 47 live portal tokens, and nothing in the type system or
 * the database would stop it.
 */

let client: SupabaseClient | null = null;

function rawClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.MASTER_INBOX_SUPABASE_URL;
  const key =
    process.env.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.MASTER_INBOX_ADMIN_TOKEN;

  if (!url) throw new NotConfiguredError("MASTER_INBOX_SUPABASE_URL");
  if (!key) throw new NotConfiguredError("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY");

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      // Same reason as the inbox client: a stale Data Cache entry would show a
      // client list that no longer exists.
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });
  return client;
}

/**
 * A query builder for one of the OS's own tables.
 *
 * Deliberately the ONLY export that reaches the database, and deliberately
 * narrower than `SupabaseClient` — there is no way to get the underlying
 * client back out, so there is no way to address another table by accident.
 */
export function osTable(table: OsTable) {
  // Runtime check, not just the type: this is called from scripts and
  // route handlers where the argument can arrive as a plain string.
  if (!isOsTable(table)) throw new NotAnOsTableError(table);
  return rawClient().from(table);
}
