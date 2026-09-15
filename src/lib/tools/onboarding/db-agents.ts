import "server-only";

import { getOnboardingDb } from "./db";
import { mlsCodes } from "./client-field-types";
import { buildFilters, cleanTerm as clean, DEFAULT_EXCLUDED_TITLES, mapBisonFields } from "./lead-filters";

/*
 * Queries against the scraped data (public.agents / offices / mls / agent_mls)
 * — Agent Search's half of the shared database. READ-ONLY, and db.ts's guard
 * throws before the network call on any write outside `orch_*`.
 *
 * Ported from the tool's `lib/db-agents.ts`. Lead search reuses the DB app's
 * filter engine — the `fn_filter_search` RPC — so the lead list is IDENTICAL to
 * what the DB app UI would produce for the same filters. Firm/team search stays
 * a direct word-boundary regex because the RPC's brand/office match is exact-only.
 */

export type FirmAgent = {
  agent_id: string; name: string | null; email: string | null; phone: string | null;
  role: string | null; brand: string | null; office_name: string | null;
};

export type LeadAgent = { agent_id: string; data: Record<string, unknown> };

type AgentRow = {
  id: string; full_name: string | null; preferred_email: string | null; preferred_phone: string | null;
  title: string | null; brand: string | null; office_name: string | null; office_city: string | null;
};

/** Step 6/8 — the client's own firm agents (fuzzy: firm in brand OR office_name). */
export async function searchFirmAgents(params: { firm: string; location?: string }): Promise<FirmAgent[]> {
  const firm = clean(params.firm || "");
  if (!firm) return [];

  // Word-boundary regex so "Rise" matches "Rise Realty" but NOT "Sunrise" / "Enterprises".
  const escaped = firm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `\\y${escaped}\\y`; // \y = Postgres word boundary; imatch = case-insensitive ~*
  const cols = "id, full_name, preferred_email, preferred_phone, title, brand, office_name, office_city";
  const db = getOnboardingDb();
  const runs = await Promise.all([
    db.from("agents").select(cols).filter("brand", "imatch", pattern).limit(1000),
    db.from("agents").select(cols).filter("office_name", "imatch", pattern).limit(1000),
  ]);

  const byId = new Map<string, AgentRow>();
  for (const r of runs) {
    if (r.error) throw new Error(r.error.message);
    for (const a of (r.data ?? []) as AgentRow[]) byId.set(a.id, a);
  }

  let rows = [...byId.values()];
  if (params.location) {
    const city = clean(params.location.split(",")[0]).toLowerCase();
    if (city) rows = rows.filter((a) => (a.office_city ?? "").toLowerCase().includes(city));
  }

  return rows.map((a) => ({
    agent_id: a.id, name: a.full_name, email: a.preferred_email, phone: a.preferred_phone,
    role: a.title, brand: a.brand, office_name: a.office_name,
  }));
}

/**
 * Resolve the client's REAL brokerage brand as it appears in the scraped data.
 * The legal/Courted brand often differs from what the client types (e.g. "Rise"
 * is actually "Real Brokerage Technologies"). Found by looking up the client's
 * own contact in `agents` (by email, then name) and reading their `brand`.
 */
export async function resolveClientBrand(params: {
  email?: string | null; contactName?: string | null; location?: string | null;
}): Promise<string | null> {
  const db = getOnboardingDb();
  // Email = unique — an exact match is always the right person.
  const email = (params.email ?? "").trim();
  if (email) {
    const { data } = await db.from("agents").select("brand")
      .ilike("preferred_email", email).not("brand", "is", null).limit(1);
    const brand = (data as { brand: string | null }[] | null)?.[0]?.brand;
    if (brand) return brand;
  }

  // Name fallback — names repeat, so cross-check against the client's city and only
  // trust the result when it points at ONE brand. Ambiguous -> null (never guess).
  const name = clean(params.contactName ?? "");
  if (!name) return null;
  const { data: rows } = await db.from("agents").select("brand, office_city")
    .ilike("full_name", name).not("brand", "is", null).limit(25);
  const found = (rows ?? []) as { brand: string; office_city: string | null }[];
  if (!found.length) return null;

  const city = clean((params.location ?? "").split(",")[0]).toLowerCase();
  const inCity = city ? found.filter((r) => (r.office_city ?? "").toLowerCase().includes(city)) : [];
  const pool = inCity.length ? inCity : found;
  const brands = [...new Set(pool.map((r) => r.brand))];
  return brands.length === 1 ? brands[0] : null;
}

/**
 * Resolve MLS uuid(s) from the client's MLS field (match `code` or `name`). A
 * client can recruit across several MLS, so every code they carry is resolved
 * and the union goes into the filter.
 */
async function resolveMlsIds(mls?: string): Promise<string[]> {
  const codes = mlsCodes(mls).map(clean).filter(Boolean);
  if (!codes.length) return [];
  const { data, error } = await getOnboardingDb()
    .from("mls").select("id")
    .or(codes.flatMap((c) => [`code.ilike.%${c}%`, `name.ilike.%${c}%`]).join(","));
  if (error) throw new Error(error.message);
  return [...new Set(((data ?? []) as { id: string }[]).map((r) => r.id))];
}

/** Steps 7-10 — filtered lead agents via the DB app's fn_filter_search RPC. */
export async function searchLeadAgents(params: {
  mls?: string; location?: string; source?: "all" | "courted" | "zillow_realtor";
  salesVolumeMin?: number; salesVolumeMax?: number;
  closedTransactionsMin?: number; closedTransactionsMax?: number;
  excludeFirms?: string[]; excludeBrands?: string[]; excludeOffices?: string[];
  excludeTitles?: string[]; cap?: number;
}): Promise<LeadAgent[]> {
  const mlsIds = await resolveMlsIds(params.mls);
  const filters = buildFilters({
    mlsIds, location: params.location,
    salesVolumeMin: params.salesVolumeMin, salesVolumeMax: params.salesVolumeMax,
    closedTransactionsMin: params.closedTransactionsMin, closedTransactionsMax: params.closedTransactionsMax,
    excludeBrands: params.excludeBrands,
    excludeOffices: [...(params.excludeFirms ?? []), ...(params.excludeOffices ?? [])],
    excludeTitles: params.excludeTitles ?? DEFAULT_EXCLUDED_TITLES,
  });

  const cap = params.cap ?? 50000;
  const pageSize = 1000;
  const out: LeadAgent[] = [];
  const db = getOnboardingDb();

  for (let offset = 0; offset < cap; offset += pageSize) {
    const { data: res, error } = await db.rpc("fn_filter_search", {
      p_mode: "agent",
      p_source: params.source ?? "all",
      p_filters: filters,
      p_sort_by: "sales_volume",
      p_sort_dir: "desc",
      p_limit: Math.min(pageSize, cap - offset),
      p_offset: offset,
    });
    if (error) throw new Error(error.message);

    const page = (res ?? {}) as { data?: Record<string, unknown>[]; totalCount?: number };
    const rows = page.data ?? [];
    for (const a of rows) out.push({ agent_id: String(a.id), data: mapBisonFields(a, params.mls) });

    const total = Number(page.totalCount ?? 0);
    if (offset + rows.length >= total || rows.length === 0) break;
  }
  return out;
}
