import "server-only";

import { cache } from "react";

import { normaliseName } from "@/lib/reconcile/names";
import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";
import { getMasterInboxSupabase, workspaceId } from "@/lib/tools/master-inbox/supabase";

/*
 * The one client list the whole OS agrees on.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Three tools keep three client lists in three separate Supabase projects, and
 * they disagree — that disagreement is what `/reconcile/clients` was built to
 * show. Left alone, each OS screen picks whichever list is nearest, and the
 * same client is named three ways on three tabs of the same product.
 *
 * So the OS resolves clients HERE, once, and every screen reads the result.
 *
 * ---------------------------------------------------------------------------
 * WHY MASTER INBOX IS THE SPINE
 *
 * Not because it is the biggest, though it is (58 rows). Because it is the one
 * with consequences: `clients.portal_token` is the address of a live client
 * portal, and 47 of those are in customers' hands right now. Any other choice
 * of spine would mean mapping the canonical list back onto that table to serve
 * a portal, and a mapping that can be wrong is a portal that can 404.
 *
 * It is also the only list with a real primary key. Client Health and Analytics
 * both join clients by normalised name, which is precisely why they drift.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 *
 * It does not write. It does not reconcile, merge, rename or create anything in
 * any tool. The live deployments keep their own tables untouched and keep
 * working exactly as they do today — the uniformity is inside the OS, which is
 * where the inconsistency was visible.
 *
 * A client that exists in another tool but not in Master Inbox is reported as
 * `unmatched` rather than invented. Silently adding it would make this the
 * fourth disagreeing list instead of the thing that ends the disagreement.
 */

export interface CanonicalClient {
  /** Master Inbox's `clients.id` — the only real key any tool has. */
  id: string;
  name: string;
  slug: string | null;
  /** Alternate spellings the inbox already tracks; used for matching. */
  aliases: string[];
  /** True when a customer can open this client's portal right now. */
  portalLive: boolean;
  /** The key every other tool is matched on. */
  key: string;
}

/**
 * Every client the business has, as one list.
 *
 * Ordered by name so a screen never has to sort it, and so two screens
 * rendering the same list render it the same way.
 */
async function fetchCanonical(): Promise<CanonicalClient[]> {
  const ws = await workspaceId();
  const { data, error } = await getMasterInboxSupabase()
    .from("clients")
    .select("id, name, slug, aliases, portal_token, portal_enabled")
    .eq("workspace_id", ws)
    .order("name");

  // An empty list is a legitimate answer; a failed read is not. Returning []
  // on error would render "no clients" and look like a data problem rather
  // than a broken query — the failure mode that hid "0 clients" twice before.
  if (error) throw new Error(`Canonical client list unavailable: ${error.message}`);

  return (data ?? []).map((row) => {
    const aliases = Array.isArray(row.aliases) ? (row.aliases as string[]) : [];
    return {
      id: row.id as string,
      name: (row.name as string) ?? "",
      slug: (row.slug as string | null) ?? null,
      aliases,
      portalLive: Boolean(row.portal_token) && row.portal_enabled !== false,
      key: normaliseName((row.name as string) ?? ""),
    };
  });
}

/*
 * 60s, matching the inbox's own client cache. Long enough that a screen full
 * of client chips costs one query; short enough that a rename surfaces while
 * the person who made it is still looking at the screen.
 */
export const loadCanonicalClients = cache(ttlCache(fetchCanonical, { ttlMs: 60_000 }));

/**
 * Resolves a name from any tool to the canonical client, or null.
 *
 * Matching is exact-on-normalised-name, plus the aliases the inbox already
 * maintains. Deliberately NOT fuzzy: `similarity()` exists for the reconcile
 * screen, where a human reads "likely" matches and decides. Guessing silently
 * here would attach one client's data to another's row, and nobody would see
 * it happen.
 */
export async function resolveClient(name: string | null | undefined): Promise<CanonicalClient | null> {
  if (!name) return null;
  const key = normaliseName(name);
  if (!key) return null;

  const clients = await loadCanonicalClients();
  const direct = clients.find((c) => c.key === key);
  if (direct) return direct;

  return clients.find((c) => c.aliases.some((a) => normaliseName(a) === key)) ?? null;
}

export interface MatchedRoster<T> {
  /** Rows that resolved to a canonical client, keyed by canonical id. */
  matched: Map<string, T>;
  /** Rows that did not. Surfaced, never dropped — see the note above. */
  unmatched: { name: string; row: T }[];
}

/**
 * Maps another tool's rows onto the canonical list.
 *
 * The unmatched bucket is the point of the return shape: a screen that only
 * consumed `matched` would quietly lose rows, and the resulting "why is this
 * client missing from Analytics" is the hardest kind of bug to find, because
 * nothing failed.
 */
export async function matchToCanonical<T>(
  rows: T[],
  nameOf: (row: T) => string | null | undefined,
): Promise<MatchedRoster<T>> {
  const matched = new Map<string, T>();
  const unmatched: { name: string; row: T }[] = [];

  for (const row of rows) {
    const name = nameOf(row);
    const client = await resolveClient(name);
    if (client) matched.set(client.id, row);
    else unmatched.push({ name: name ?? "(unnamed)", row });
  }

  return { matched, unmatched };
}
