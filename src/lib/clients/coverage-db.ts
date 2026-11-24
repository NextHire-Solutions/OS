import "server-only";

import { BROKERSTAFFER_PORTAL_ID } from "@/lib/crm-preview/market-model";

import { osTable } from "./os-db";
import { cleanCoverage, cleanMlsAreas, readMlsAreas, type Coverage, type MlsAreas } from "./coverage";

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
  // BrokerStaffer's own record (known by its portal, whatever it is called): its MLS list has no 40 limit (3 Nov).
  let house = false;
  if (input.mls !== undefined) {
    const { data } = await osTable("os_clients").select("mi_client_id").eq("id", clientId).maybeSingle();
    house = (data as { mi_client_id?: string | null } | null)?.mi_client_id === BROKERSTAFFER_PORTAL_ID;
  }
  const { value, problems } = cleanCoverage(input, { house });
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

/*
 * The area for each MLS (os_clients.mls_areas, migration 0056). Read on its own — never in listCoverage's select,
 * where a column not there yet would blank every client's Markets / MLS / Area.
 */
const MIGRATION_0056 = "Area for each MLS needs migrations/0056_mls_areas.sql run in the Master Inbox Supabase project.";

/** One client's map; null when the column isn't there yet (migration 0056 not run). */
export async function getMlsAreas(clientId: string): Promise<MlsAreas | null> {
  const { data, error } = await osTable("os_clients").select("id, mls_areas").eq("id", clientId).maybeSingle();
  if (error) {
    if (missing(error.message)) return null;
    throw new CoverageError(error.message, 502);
  }
  if (!data) throw new CoverageError("No such client", 404);
  return readMlsAreas((data as { mls_areas?: unknown }).mls_areas);
}

/** Every client's map (by os_clients id); empty when the column isn't there yet — never a failure. */
export async function listMlsAreas(): Promise<Map<string, MlsAreas>> {
  try {
    const { data, error } = await osTable("os_clients").select("id, mls_areas");
    if (error) return new Map();
    return new Map(((data ?? []) as unknown as Array<{ id: string; mls_areas: unknown }>).map((r) => [String(r.id), readMlsAreas(r.mls_areas)]));
  } catch {
    return new Map();
  }
}

/** Replace a client's map (checked against its MLS list). Returns the saved map. */
export async function setMlsAreas(clientId: string, input: unknown): Promise<MlsAreas> {
  const { mls } = await getCoverage(clientId);
  const { value, problems } = cleanMlsAreas(input, mls);
  if (problems.length) throw new CoverageError(problems.join(" "));
  const { data, error } = await osTable("os_clients").update({ mls_areas: value, updated_at: new Date().toISOString() }).eq("id", clientId).select("id, mls_areas").maybeSingle();
  if (error) throw new CoverageError(missing(error.message) ? MIGRATION_0056 : error.message, missing(error.message) ? 409 : 502);
  if (!data) throw new CoverageError("No such client", 404);
  return readMlsAreas((data as { mls_areas?: unknown }).mls_areas);
}
