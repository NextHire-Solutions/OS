/*
 * The lead-list filter, as the DB app's `fn_filter_search` RPC expects it.
 * Ported from the tool's `lib/db-agents.ts` (`buildFilters`, `mapBisonFields`).
 * Pure, so the shape that decides who gets emailed is under test.
 */

/** PostgREST `.or()` / ilike patterns treat commas and parens specially — strip them from user input. */
export const cleanTerm = (s: string): string => s.replace(/[(),]/g, " ").trim();

/** Default: exclude managers + team leaders (mirrors the manual Courted agent-type exclusion). */
export const DEFAULT_EXCLUDED_TITLES = ["Team Leader", "Managing Broker"];

export function buildFilters(p: {
  mlsIds: string[]; location?: string;
  salesVolumeMin?: number; salesVolumeMax?: number;
  closedTransactionsMin?: number; closedTransactionsMax?: number;
  excludeBrands?: string[]; excludeOffices?: string[]; excludeTitles?: string[];
}): Record<string, unknown> {
  const s = (n?: number) => (n == null ? "" : String(n));
  const filters: Record<string, unknown> = {
    salesVolume: { side: "all", buckets: [], min: s(p.salesVolumeMin), max: s(p.salesVolumeMax) },
    closedTransactions: { side: "all", buckets: [], min: s(p.closedTransactionsMin), max: s(p.closedTransactionsMax) },
    mls: { include: p.mlsIds, exclude: [] },
    // DNC Your Agents / Custom — exact-match exclusion on the client's own brand/office.
    officeSearch: {
      brand: { include: [], exclude: (p.excludeBrands ?? []).filter(Boolean) },
      office: { include: [], exclude: (p.excludeOffices ?? []).filter(Boolean) },
    },
    // Agent type — exclude managers/team leaders (recruit producing agents, not leadership).
    title: { include: [], exclude: (p.excludeTitles ?? []).filter(Boolean) },
  };
  if (p.location) {
    const city = cleanTerm(p.location.split(",")[0]);
    if (city) filters.location = { field: "city", appliesTo: ["office", "transacted"], values: [city] };
  }
  return filters;
}

/** Map a fn_filter_search agent row -> the Bison "Both Emails" field set. */
export function mapBisonFields(a: Record<string, unknown>, mlsFallback?: string): Record<string, unknown> {
  const mls = Array.isArray(a.mls)
    ? (a.mls as { code?: string }[]).map((m) => m.code).filter(Boolean).join(" | ")
    : "";
  return {
    final_email: a.preferred_email, first_name: a.first_name, last_name: a.last_name,
    office_name: a.office_name, office_city: a.office_city,
    preferred_phone_number: a.preferred_phone,
    buy_side: a.buy_side_dollar, list_side: a.list_side_dollar,
    sales_volume: a.sales_volume, approx_gci: a.approx_gci,
    avg_sales_price: a.avg_sale_price, closed_transactions: a.closed_transactions,
    closed_rentals: a.closed_rentals,
    mls_affiliation: mls || mlsFallback || "",
    most_transacted_city: a.most_transacted_city,
  };
}

/** Normalise a person or office name for DNC matching — exact, case-insensitive, whitespace-collapsed. */
export const normName = (s?: string | null): string => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Drop leads whose person name OR office name is on the DNC list. Free-text DNC
 * entries can be either, so both are checked.
 */
export function withoutDnc<T extends { data: Record<string, unknown> }>(leads: T[], dncNames: Iterable<string>): T[] {
  const dnc = new Set([...dncNames].map(normName).filter(Boolean));
  if (!dnc.size) return leads;
  return leads.filter((l) => {
    const d = l.data;
    return !dnc.has(normName(`${d.first_name ?? ""} ${d.last_name ?? ""}`)) && !dnc.has(normName(d.office_name as string));
  });
}
