import "server-only";

import { ttlCache } from "@/lib/cache/ttl";
import { osTable } from "@/lib/clients/os-db";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { readOnly } from "@/lib/tools/assistant/read-only";
import { getCorofySupabase } from "@/lib/tools/corofy/supabase";
import { loadAgentEntries, loadDncEntries, loadPipelineEntries } from "@/lib/tools/master-inbox/portals/portal-data";

import {
  bandRows, clientForPortal, DEAL_BANDS, LIST_PILL, listFor, listSets, marketFilters, PAGE_SIZE, rangeFilter, resolveMls, SALES_BANDS,
  type GroupRow, type MarketQuery, type MlsRow, type OsClientRow, type ReportGroup,
} from "./market-model";

/*
 * The redesign's Market, Prospects and Reports, read for the preview. See
 * market-model.ts for what each is, and src/app/crm-preview/page.tsx for who
 * may see them.
 *
 * READ-ONLY. Both databases are reached through the assistant's read-only
 * guard (insert/update/delete throw before a request exists), and the agent
 * database only through the Database app's own STABLE search functions,
 * inside which Postgres itself refuses a write.
 *
 * The agent database is live — the Database app, the scraper and the
 * onboarding app use it — so a report's counts run four at a time, and a
 * market's report is kept for 30 minutes.
 */

const agentDb = () => readOnly(getCorofySupabase());
const mi = () => readOnly(createAdminSupabase());

type Rpc = { data: unknown; error: { message?: string } | null };

async function rpc(fn: "fn_filter_search" | "fn_facet_options", args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = (await agentDb().rpc(fn, args)) as Rpc;
  if (error) throw new Error(error.message ?? `${fn} failed`);
  return data;
}

async function search(filters: Record<string, unknown>, limit: number, offset = 0) {
  const d = (await rpc("fn_filter_search", {
    p_mode: "agent", p_source: "all", p_filters: filters, p_sort_by: "sales_volume", p_sort_dir: "desc", p_limit: Math.max(limit, 1), p_offset: offset,
  })) as { data?: Array<Record<string, unknown>>; totalCount?: number; salesVolumeTotal?: number } | null;
  return { rows: d?.data ?? [], total: Number(d?.totalCount) || 0, salesVolume: Number(d?.salesVolumeTotal) || 0 };
}

/** At most `n` at once — the agent database is shared with the live apps. */
async function pooled<T>(jobs: Array<() => Promise<T>>, n = 4): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  }));
  return out;
}

const mlsRows = ttlCache(async (): Promise<MlsRow[]> => {
  const { data, error } = await agentDb().from("mls").select("id, code, name, aliases");
  if (error) throw new Error(error.message);
  return (data ?? []) as MlsRow[];
}, { ttlMs: 30 * 60_000, key: () => "mls", shared: "crm-preview-mls" });

export interface MarketContext {
  portal: { id: string; name: string };
  client: { id: string; name: string } | null;
  mls: { ids: string[]; matched: Array<{ code: string; name: string }>; unmatched: string[] };
  orchClientId: string | null;
}

/** A portal's client, its market's MLSs and its id in the agent database. Null for no such portal. */
export async function marketContext(portalId: string): Promise<MarketContext | null> {
  const { data: portal } = await mi().from("clients").select("id, name, slug, portal_token").eq("id", portalId).maybeSingle();
  const p = portal as { id: string; name: string | null; slug: string | null; portal_token: string | null } | null;
  if (!p || p.slug === "unknown" || !p.portal_token) return null;
  const [{ data: rows, error }, mls] = await Promise.all([
    osTable("os_clients").select("id, name, aliases, mi_client_id, mls_codes, orch_client_id"),
    mlsRows(),
  ]);
  if (error) throw new Error(error.message);
  const client = clientForPortal({ id: p.id, name: p.name ?? "" }, (rows ?? []) as unknown as OsClientRow[]);
  return {
    portal: { id: p.id, name: p.name ?? "Unnamed client" },
    client: client ? { id: client.id, name: client.name } : null,
    mls: resolveMls(client?.mls_codes, mls),
    orchClientId: client?.orch_client_id ?? null,
  };
}

const marketBase = (ctx: MarketContext) => ({ mls: { include: ctx.mls.ids, exclude: [] } });
const prospectsBase = (ctx: MarketContext) => ({ orchClientIds: [ctx.orchClientId], orchClientMode: "include" });

/** Why a list cannot be shown for this client, or null when it can. */
export function unavailable(ctx: MarketContext, list: "market" | "prospects"): string | null {
  if (!ctx.client) return "This portal is not linked to a client record, so its market is unknown.";
  if (list === "market" && ctx.mls.ids.length === 0) {
    return ctx.mls.unmatched.length
      ? `The MLS on ${ctx.client.name}'s record (${ctx.mls.unmatched.join(", ")}) is not in the agent database.`
      : `${ctx.client.name}'s record has no MLS yet (Clients → the client → Markets), so its market is unknown.`;
  }
  if (list === "prospects" && !ctx.orchClientId) return `${ctx.client.name} is not linked in the agent database, so its lists cannot be read.`;
  return null;
}

/*
 * Which of these agents are in the client's lists — the Database app's own
 * rule (fn_agent_where, orchClientIds): the client's campaign leads, or its
 * lead list while it has no campaign leads at all.
 */
async function inClientLists(orchClientId: string, agentIds: string[]): Promise<Set<string>> {
  if (!agentIds.length) return new Set();
  const db = agentDb();
  const { data: probe } = await db.from("v_agent_campaigns").select("agent_id").eq("client_id", orchClientId).limit(1);
  const table = (probe ?? []).length ? "v_agent_campaigns" : "orch_client_leads";
  const { data, error } = await db.from(table).select("agent_id").eq("client_id", orchClientId).in("agent_id", agentIds);
  if (error) throw new Error(error.message);
  return new Set(((data ?? []) as Array<{ agent_id: string | null }>).map((r) => r.agent_id).filter((x): x is string => !!x));
}

export interface MarketRow {
  id: string;
  name: string;
  title: string | null;
  brokerage: string | null;
  officeCity: string | null;
  mostTransactedCity: string | null;
  salesVolume: number | null;
  units: number | null;
  list: string;
  pill: string;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One page of Market or Prospects. Emails are read to place agents on lists and never leave the server. */
export async function marketPage(ctx: MarketContext, q: MarketQuery) {
  const why = unavailable(ctx, q.list);
  if (why) return { unavailable: why };
  const base = q.list === "prospects" ? prospectsBase(ctx) : marketBase(ctx);
  const page = await search(marketFilters(base, q), PAGE_SIZE, (q.page - 1) * PAGE_SIZE);
  const ids = page.rows.map((r) => String(r.id));
  const [prospects, myAgents, dnc, pipeline] = await Promise.all([
    q.list === "prospects" ? Promise.resolve(new Set(ids)) : inClientLists(ctx.orchClientId ?? "", ctx.orchClientId ? ids : []),
    loadAgentEntries(ctx.portal.id),
    loadDncEntries(ctx.portal.id),
    loadPipelineEntries(ctx.portal.id),
  ]);
  const sets = listSets(myAgents, dnc, pipeline, prospects);
  const rows: MarketRow[] = page.rows.map((r) => {
    const list = listFor({ id: String(r.id), full_name: str(r.full_name), emails: [str(r.preferred_email), str(r.enriched_email)].filter((e): e is string => !!e) }, sets);
    return {
      id: String(r.id),
      name: str(r.full_name) ?? "Unnamed agent",
      title: str(r.title),
      brokerage: str(r.brand) ?? str(r.office_name),
      officeCity: str(r.office_city),
      mostTransactedCity: str(r.most_transacted_city),
      salesVolume: num(r.sales_volume),
      units: num(r.units),
      list,
      pill: LIST_PILL[list],
    };
  });
  return { total: page.total, page: q.page, pageSize: PAGE_SIZE, rows };
}

/** The chips' choices for a market: its brokerages and counties, largest first. */
export const marketOptions = ttlCache(async (ctx: MarketContext): Promise<{ brokerages: string[]; counties: string[] }> => {
  if (unavailable(ctx, "market")) return { brokerages: [], counties: [] };
  const [brands, counties] = await Promise.all([
    rpc("fn_facet_options", { p_type: "brand", p_q: "", p_field: null, p_source: "all", p_filters: marketBase(ctx) }),
    rpc("fn_facet_options", { p_type: "location", p_q: "", p_field: "county", p_source: "all", p_filters: marketBase(ctx) }),
  ]);
  return {
    brokerages: ((Array.isArray(brands) ? brands : []) as Array<{ v: string }>).map((b) => b.v).slice(0, 40),
    counties: (((counties as { options?: Array<{ v: string }> } | null)?.options ?? []).map((c) => c.v)).slice(0, 40),
  };
}, { ttlMs: 30 * 60_000, key: (ctx) => `options:${[...ctx.mls.ids].sort().join(",")}`, shared: "crm-preview-market-options", inflightTimeoutMs: 120_000 });

/*
 * Reports › All market. Every figure is an exact count of agents in the
 * market (fn_filter_search), except two things taken from the Database app's
 * option lists, both only to choose WHICH groups to count:
 *   - brokerages: its brand list is an exact count per brand (checked against
 *     a direct count on 16 Oct: Keller Williams in C21's market 11,863 both ways);
 *   - office cities: its city list counts an agent once per location kind
 *     and once per MLS (Atlanta: 31,727 listed, 15,279 by office), so it only
 *     names the candidates; each is then counted by office city exactly.
 */
export interface MarketReport {
  total: number;
  groups: ReportGroup[];
  /** Every brokerage the Database app lists for the market (its largest 50), for "See all". */
  allBrokerages: GroupRow[];
}

export const marketReport = ttlCache(async (ctx: MarketContext): Promise<MarketReport | { unavailable: string }> => {
  const why = unavailable(ctx, "market");
  if (why) return { unavailable: why };
  const base = marketBase(ctx);
  const [all, brands, cities] = await Promise.all([
    search(base, 1),
    rpc("fn_facet_options", { p_type: "brand", p_q: "", p_field: null, p_source: "all", p_filters: base }),
    rpc("fn_facet_options", { p_type: "location", p_q: "", p_field: "city", p_source: "all", p_filters: base }),
  ]);
  const brandRows = ((Array.isArray(brands) ? brands : []) as Array<{ v: string; n: number }>).map((b) => ({ label: b.v, n: Number(b.n) || 0 }));
  const candidates = (((cities as { options?: Array<{ v: string }> } | null)?.options ?? []).map((c) => c.v)).slice(0, 10);

  const officeCity = (v: string) => ({ ...base, location: { field: "city", appliesTo: ["office"], values: [v], excludeValues: [], excludeField: "city" } });
  const jobs: Array<() => Promise<number>> = [
    ...candidates.map((v) => () => search(officeCity(v), 1).then((r) => r.total)),
    ...SALES_BANDS.map((b) => () => search({ ...base, salesVolume: rangeFilter(b) }, 1).then((r) => r.total)),
    ...DEAL_BANDS.map((b) => () => search({ ...base, closedTransactions: rangeFilter(b) }, 1).then((r) => r.total)),
  ];
  const counts = await pooled(jobs, 4);
  const cityCounts = counts.slice(0, candidates.length);
  const salesCounts = counts.slice(candidates.length, candidates.length + SALES_BANDS.length);
  const dealCounts = counts.slice(candidates.length + SALES_BANDS.length);

  const bands = (labels: ReadonlyArray<{ label: string }>, n: number[]): GroupRow[] => {
    const m = new Map(labels.map((b, i) => [b.label, n[i]]));
    const known = n.reduce((s, x) => s + x, 0);
    if (all.total > known) m.set("Unknown", all.total - known);
    return bandRows(m, labels);
  };
  // City names as the design shows them ("Atlanta"); "City, ST" only when the market crosses states
  // (ChuckTown's Columbia is SC, and another market's could be MO).
  const states = new Set(candidates.map((v) => (/,\s*([A-Z]{2})$/.exec(v)?.[1] ?? "")));
  const oneState = states.size === 1 && !states.has("");
  const cityRows = candidates
    .map((v, i) => ({ label: oneState ? v.replace(/,\s*[A-Z]{2}$/, "") : v, n: cityCounts[i] }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);
  return {
    total: all.total,
    groups: [
      // The list stops at 50, so "of N" is only said when it is all of them.
      { title: "Current brokerage", rows: brandRows.slice(0, 8), ...(brandRows.length < 50 ? { of: { shown: Math.min(8, brandRows.length), total: brandRows.length, noun: "brokerages" } } : {}) },
      { title: "Office city", rows: cityRows },
      { title: "Sales volume, last 12 months", rows: bands(SALES_BANDS, salesCounts) },
      { title: "Deals closed, last 12 months", rows: bands(DEAL_BANDS, dealCounts) },
    ],
    allBrokerages: brandRows,
  };
}, { ttlMs: 30 * 60_000, key: (ctx) => `report:${[...ctx.mls.ids].sort().join(",")}`, shared: "crm-preview-market-report", inflightTimeoutMs: 180_000 });
