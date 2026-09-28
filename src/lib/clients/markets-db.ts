import "server-only";

import { osTable } from "./os-db";
import {
  clean,
  sortMarkets,
  validateMarket,
  type MarketInput,
  type MarketRow,
} from "./markets.ts";

/*
 * Reading and writing a client's markets. The rule lives in `markets.ts`; this
 * file only talks to the database.
 *
 * `os_client_markets` is on the `os-tables.ts` allowlist, so these calls go
 * through the same guard as every other OS table — a mistyped table name fails
 * before the network call rather than reaching Master Inbox's own tables, which
 * share this database and carry triggers that reach customer portals.
 *
 * Every write re-reads the client's rows first and validates against them, so
 * the duplicate check runs on current data rather than on whatever the browser
 * last saw. The unique index is still the final authority — this exists so the
 * common case is a readable message instead of a 23505.
 */

const COLUMNS = "id, market, mls, area";

export type MarketsResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; field?: string };

/** Turns the one Postgres error we expect into the message we would have given. */
function fromPgError(error: { code?: string; message?: string }): MarketsResult<never> {
  if (error.code === "23505") {
    return {
      ok: false, status: 409, field: "row",
      error: "This client already covers that market, MLS and area.",
    };
  }
  if (error.code === "23514") {
    return { ok: false, status: 400, field: "market", error: "A market is required." };
  }
  return { ok: false, status: 502, error: error.message ?? "The write was rejected" };
}

/** Every market this client covers, in display order. */
export async function listMarkets(clientId: string): Promise<MarketsResult<MarketRow[]>> {
  const { data, error } = await osTable("os_client_markets")
    .select(COLUMNS)
    .eq("client_id", clientId);
  if (error) return { ok: false, status: 502, error: error.message };
  return { ok: true, value: sortMarkets((data ?? []) as unknown as MarketRow[]) };
}

/**
 * Every market row across every client — the source of the Add dialog's
 * suggestions.
 *
 * Deliberately unfiltered and uncapped: the table holds a handful of rows per
 * client, so this is small, and a LIMIT here would silently narrow the
 * suggestions as the list grew, which is the sort of thing nobody notices.
 */
export async function listAllMarkets(): Promise<MarketsResult<MarketRow[]>> {
  const { data, error } = await osTable("os_client_markets").select(COLUMNS);
  if (error) return { ok: false, status: 502, error: error.message };
  return { ok: true, value: (data ?? []) as unknown as MarketRow[] };
}

export async function addMarket(
  clientId: string,
  input: MarketInput,
): Promise<MarketsResult<MarketRow>> {
  const current = await listMarkets(clientId);
  if (!current.ok) return current;

  const problem = validateMarket(input, current.value);
  if (problem) return { ok: false, status: 400, error: problem.message, field: problem.field };

  const { data, error } = await osTable("os_client_markets")
    .insert({ client_id: clientId, ...clean(input) })
    .select(COLUMNS)
    .single();
  if (error) return fromPgError(error);
  return { ok: true, value: data as unknown as MarketRow };
}

export async function updateMarket(
  clientId: string,
  id: string,
  input: MarketInput,
): Promise<MarketsResult<MarketRow>> {
  const current = await listMarkets(clientId);
  if (!current.ok) return current;
  if (!current.value.some((r) => r.id === id)) {
    // Scoped to the client on purpose: an id from another client must not be
    // editable by guessing it.
    return { ok: false, status: 404, error: "That market is not on this client." };
  }

  const problem = validateMarket(input, current.value, id);
  if (problem) return { ok: false, status: 400, error: problem.message, field: problem.field };

  const { data, error } = await osTable("os_client_markets")
    .update({ ...clean(input), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("client_id", clientId)
    .select(COLUMNS)
    .single();
  if (error) return fromPgError(error);
  return { ok: true, value: data as unknown as MarketRow };
}

export async function removeMarket(
  clientId: string,
  id: string,
): Promise<MarketsResult<{ id: string }>> {
  // Both keys in the filter, so a wrong id cannot delete another client's row
  // even if the caller is confused about which client it is editing.
  const { data, error } = await osTable("os_client_markets")
    .delete()
    .eq("id", id)
    .eq("client_id", clientId)
    .select("id");
  if (error) return { ok: false, status: 502, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, status: 404, error: "That market is not on this client." };
  }
  return { ok: true, value: { id } };
}
