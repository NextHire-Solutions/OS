import "server-only";

import { osTable } from "./os-db";
import { cleanCoverage, type Coverage } from "./coverage";

/*
 * Markets / MLS / Area on the master record (os_clients, migration 0022).
 * The only reader and writer of those three columns.
 */

export class CoverageError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CoverageError";
    this.status = status;
  }
}

const MIGRATION = "Markets, MLS and Area need migrations/0022_client_coverage.sql run in the Master Inbox Supabase project.";
const missing = (m: string) => /column .* does not exist|schema cache/i.test(m);

type Row = { id: string; market_count: number | null; mls_codes: string[] | null; areas: string[] | null };
const toCoverage = (r: Row): Coverage => ({ markets: r.market_count ?? null, mls: r.mls_codes ?? [], areas: r.areas ?? [] });

export async function getCoverage(clientId: string): Promise<Coverage> {
  const { data, error } = await osTable("os_clients").select("id, market_count, mls_codes, areas").eq("id", clientId).maybeSingle();
  if (error) throw new CoverageError(missing(error.message) ? MIGRATION : error.message, missing(error.message) ? 409 : 502);
  if (!data) throw new CoverageError("No such client", 404);
  return toCoverage(data as unknown as Row);
}

/** Every client's coverage — null when the columns are not there yet. */
export async function listCoverage(): Promise<Map<string, Coverage> | null> {
  const { data, error } = await osTable("os_clients").select("id, market_count, mls_codes, areas");
  if (error) return null;
  return new Map(((data ?? []) as unknown as Row[]).map((r) => [r.id, toCoverage(r)]));
}

/** Change some of the three. Returns the saved coverage. */
export async function setCoverage(clientId: string, input: { markets?: unknown; mls?: unknown; areas?: unknown }): Promise<Coverage> {
  const { value, problems } = cleanCoverage(input);
  if (problems.length) throw new CoverageError(problems.join(" "));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (value.markets !== undefined) patch.market_count = value.markets;
  if (value.mls !== undefined) patch.mls_codes = value.mls;
  if (value.areas !== undefined) patch.areas = value.areas;
  const { data, error } = await osTable("os_clients").update(patch).eq("id", clientId).select("id, market_count, mls_codes, areas").maybeSingle();
  if (error) throw new CoverageError(missing(error.message) ? MIGRATION : error.message, missing(error.message) ? 409 : 502);
  if (!data) throw new CoverageError("No such client", 404);
  return toCoverage(data as unknown as Row);
}
