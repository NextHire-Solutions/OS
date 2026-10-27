import "server-only";

import { ttlCache } from "@/lib/cache/ttl";
import { osTable } from "@/lib/clients/os-db";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { readOnly } from "@/lib/tools/assistant/read-only";
import { getCorofySupabase } from "@/lib/tools/corofy/supabase";
import { loadAgentEntries, loadDncEntries, loadPipelineEntries } from "@/lib/tools/master-inbox/portals/portal-data";
import { DEMO_MARKET_MLS, DEMO_PORTAL_ID, isDemoPortal } from "@/lib/crm-preview/demo";
import { searchMarket } from "@/lib/crm-preview/market-engine";
import { marketFromMemory, requestNameOrder } from "@/lib/crm-preview/market-memory";
import { agentsByIds, demoProspectIds, filterProspects, placeOf, PROSPECTS_MIGRATION, sortProspects, type AgentRow } from "@/lib/crm-preview/demo-market";

import {
  SORTS, bandRows, clientForPortal, DEAL_BANDS, LIST_PILL, listFor, listSets, marketFilters, marketScope, ownListEmail, PLACE_KINDS, rangeFilter, SETUP_PAGE_SIZE, resolveMls, SALES_BANDS,
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

async function search(filters: Record<string, unknown>, limit: number, offset = 0, sort: { by: string; dir: "asc" | "desc" } = { by: "sales_volume", dir: "desc" }) {
  const d = (await rpc("fn_filter_search", {
    p_mode: "agent", p_source: "all", p_filters: filters, p_sort_by: sort.by, p_sort_dir: sort.dir, p_limit: Math.max(limit, 1), p_offset: offset,
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

/**
 * How many salespeople a list of MLS codes brings — Onboard a client's preview of the new portal's market before the
 * client exists (28 Oct). The same rule as the portal's (resolveMls, marketScope), counted by the database — never
 * loaded into memory, so a preview never pushes out a market someone is using. Kept 30 minutes per set; reads only.
 */
export const marketSizeFor = ttlCache(async (codes: readonly string[]): Promise<{ total: number; matched: Array<{ code: string; name: string }>; unmatched: string[] }> => {
  const mls = resolveMls(codes, await mlsRows());
  if (!mls.ids.length) return { total: 0, matched: [], unmatched: mls.unmatched };
  const { total } = await search(marketScope(mls.ids), 1);
  return { total, matched: mls.matched, unmatched: mls.unmatched };
}, { ttlMs: 30 * 60_000, key: (codes) => [...codes].map((c) => c.trim().toUpperCase()).sort().join(","), shared: "crm-preview-market-size" });

export interface MarketContext {
  portal: { id: string; name: string };
  client: { id: string; name: string } | null;
  mls: { ids: string[]; matched: Array<{ code: string; name: string }>; unmatched: string[] };
  orchClientId: string | null;
}

/**
 * A portal's client record alone — no market, no agent database — for the
 * Billing link, which needs no MLS and must not wait on the agent database.
 * undefined: no such portal; null: a portal no client record is linked to.
 */
export async function portalClient(portalId: string): Promise<{ id: string; name: string } | null | undefined> {
  const { data: portal } = await mi().from("clients").select("id, name, slug, portal_token").eq("id", portalId).maybeSingle();
  const p = portal as { id: string; name: string | null; slug: string | null; portal_token: string | null } | null;
  if (!p || p.slug === "unknown" || !p.portal_token) return undefined;
  const { data: rows, error } = await osTable("os_clients").select("id, name, aliases, mi_client_id, mls_codes, orch_client_id");
  if (error) throw new Error(error.message);
  const client = clientForPortal({ id: p.id, name: p.name ?? "" }, (rows ?? []) as unknown as OsClientRow[]);
  return client ? { id: client.id, name: client.name } : null;
}

/**
 * A portal's client, its market's MLSs and its id in the agent database. Null
 * for no such portal. Kept a minute per portal (26 Oct, speed): every page,
 * filter change and choice list read the portal and every client record
 * first — ~0.7 s, the slowest part of a request once the market answers from
 * memory. A client's MLSs or a portal changed in the OS shows here within a
 * minute — the minute-old answer is served while the new one is read.
 */
export const marketContext = ttlCache(readMarketContext, { ttlMs: 60_000, staleMs: 30 * 60_000, key: (portalId) => portalId, shared: "crm-preview-market-context" });

async function readMarketContext(portalId: string): Promise<MarketContext | null> {
  const { data: portal } = await mi().from("clients").select("id, name, slug, portal_token").eq("id", portalId).maybeSingle();
  const p = portal as { id: string; name: string | null; slug: string | null; portal_token: string | null } | null;
  if (!p || p.slug === "unknown" || !p.portal_token) return null;
  const [{ data: rows, error }, mls] = await Promise.all([
    osTable("os_clients").select("id, name, aliases, mi_client_id, mls_codes, orch_client_id"),
    mlsRows(),
  ]);
  if (error) throw new Error(error.message);
  const client = clientForPortal({ id: p.id, name: p.name ?? "" }, (rows ?? []) as unknown as OsClientRow[]);
  // The Demo Portal has no client record: a sample market (demo.ts), and no lists of anyone's.
  if (!client && isDemoPortal(p.id)) {
    return { portal: { id: p.id, name: p.name ?? "Demo Portal" }, client: { id: "demo-portal", name: p.name ?? "Demo Portal" }, mls: resolveMls([...DEMO_MARKET_MLS], mls), orchClientId: null };
  }
  return {
    portal: { id: p.id, name: p.name ?? "Unnamed client" },
    client: client ? { id: client.id, name: client.name } : null,
    mls: resolveMls(client?.mls_codes, mls),
    orchClientId: client?.orch_client_id ?? null,
  };
}

// Salespeople only — the page, its choices and counts, Reports and every move read the market through this (market-model.ts).
const marketBase = (ctx: MarketContext) => marketScope(ctx.mls.ids);
const prospectsBase = (ctx: MarketContext) => ({ orchClientIds: [ctx.orchClientId], orchClientMode: "include" });

/** Why a list cannot be shown for this client, or null when it can. */
export function unavailable(ctx: MarketContext, list: "market" | "prospects"): string | null {
  if (!ctx.client) return "This portal is not linked to a client record, so its market is unknown.";
  if (list === "market" && ctx.mls.ids.length === 0) {
    return ctx.mls.unmatched.length
      ? `The MLS on ${ctx.client.name}'s record (${ctx.mls.unmatched.join(", ")}) is not in the agent database.`
      : `${ctx.client.name}'s record has no MLS yet (Clients → the client → Markets), so its market is unknown.`;
  }
  // The Demo Portal keeps its own prospects (demo-market.ts); a real client's are its campaign leads in the agent database.
  if (list === "prospects" && !ctx.orchClientId && !isDemoPortal(ctx.portal.id)) return `${ctx.client.name} is not linked in the agent database, so its lists cannot be read.`;
  return null;
}

/*
 * Which of these agents are in the client's lists — the Database app's own
 * rule (fn_agent_where, orchClientIds): the client's campaign leads, or its
 * lead list while it has no campaign leads at all.
 *
 * The whole set per client is held (27 Oct, speed: two queries a page were
 * ~0.3 s of every Market request) — read in the background, page by page,
 * and refreshed after 10 minutes while the held one is still used. Until a
 * client's set is first read, the page's agents are looked up directly, as
 * before. Never more than one read per client at a time.
 */
type ClientSet = { ids: Set<string> | null; at: number; loading: boolean };
const CLIENT_SET_MS = 10 * 60_000;
function clientSets(): Record<string, ClientSet> {
  const g = globalThis as unknown as Record<string, Record<string, ClientSet>>;
  return (g.__osCrmClientCampaignSets ??= {});
}

async function readClientSet(orchClientId: string): Promise<Set<string>> {
  const db = agentDb();
  const { data: probe, error: pErr } = await db.from("v_agent_campaigns").select("agent_id").eq("client_id", orchClientId).limit(1);
  if (pErr) throw new Error(pErr.message);
  const table = (probe ?? []).length ? "v_agent_campaigns" : "orch_client_leads";
  const ids = new Set<string>();
  for (let from = 0; from < 2_000_000; from += 1000) {
    const { data, error } = await db.from(table).select("agent_id").eq("client_id", orchClientId).not("agent_id", "is", null).order("agent_id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ agent_id: string | null }>;
    for (const r of rows) if (r.agent_id) ids.add(r.agent_id);
    if (rows.length < 1000) break;
  }
  return ids;
}

function heldClientSet(orchClientId: string, now = Date.now()): Set<string> | null {
  const all = clientSets();
  const cur = all[orchClientId];
  if (!cur || (now - cur.at > CLIENT_SET_MS && !cur.loading)) {
    all[orchClientId] = { ids: cur?.ids ?? null, at: cur?.at ?? 0, loading: true };
    void readClientSet(orchClientId)
      .then((ids) => { all[orchClientId] = { ids, at: Date.now(), loading: false }; })
      .catch(() => { all[orchClientId] = { ids: cur?.ids ?? null, at: cur?.at ?? 0, loading: false }; });
  }
  // A held set is used for up to six hours while a newer one is read; older than that, the page asks directly.
  const held = all[orchClientId];
  return held?.ids && now - held.at < 6 * 60 * 60_000 ? held.ids : null;
}

async function inClientLists(orchClientId: string, agentIds: string[]): Promise<Set<string>> {
  if (!agentIds.length) return new Set();
  const held = heldClientSet(orchClientId);
  if (held) return new Set(agentIds.filter((id) => held.has(id)));
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
  /** The office's own name (the Setup wizard's Office column). */
  office: string | null;
  /** Whole years in the industry, where the database records it. */
  years: number | null;
  /**
   * Only on the Setup wizard's eight-a-page tables (their design has an Email
   * column), and only for an agent already on the client's own lists — My
   * Agents, the DNC List, its pipeline. A market agent's or a prospect's
   * email never leaves the server (the user, 17 Oct: no one may extract the
   * data); it is only matched against the client's lists.
   */
  email?: string | null;
  list: string;
  pill: string;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One page of Market or Prospects. Emails are read to place agents on lists and never leave the server. */
/* The client's own lists: the only agents whose email may reach the browser. */
const OWN_LISTS: ReadonlySet<string> = new Set(["My Agents", "DNC List", "In your pipeline"]);

/*
 * The Demo Portal's own prospects (migration 0041): every one, filtered and
 * sorted here as Market's search would (demo-market.ts). A Demo list is small.
 */
async function demoProspects(q: MarketQuery): Promise<{ unavailable: string } | { page: { rows: Array<Record<string, unknown>>; total: number; salesVolume: number } }> {
  const ids = await demoProspectIds(mi(), DEMO_PORTAL_ID);
  if (ids === null) return { unavailable: PROSPECTS_MIGRATION };
  const shown = sortProspects(filterProspects(await agentsByIds(ids), q), q);
  const from = (q.page - 1) * q.per;
  return {
    page: { rows: shown.slice(from, from + q.per) as unknown as Array<Record<string, unknown>>, total: shown.length, salesVolume: shown.reduce((t, a) => t + (a.sales_volume ?? 0), 0) },
  };
}

/*
 * The portal's own lists, kept 20 seconds (26 Oct, speed): every page and
 * every filter change read all three — ~0.7 s, the slowest part of a request
 * once the market answers from memory. A Demo save drops them at once
 * (invalidatePortalLists, from the Demo's save route); a real portal's lists
 * change only on the live portal, and show here within 20 seconds. Past 20 s
 * the last answer is served while the new one is read (staleMs): a large
 * client's My Agents list (Keyes: 3,170, 1.7 s) never holds up a page.
 */
const portalLists = ttlCache(async (portalId: string) => {
  const [myAgents, dnc, pipeline, demoProspectsAll] = await Promise.all([
    loadAgentEntries(portalId),
    loadDncEntries(portalId),
    loadPipelineEntries(portalId),
    isDemoPortal(portalId) ? demoProspectIds(mi(), DEMO_PORTAL_ID) : Promise.resolve(null),
  ]);
  return { myAgents, dnc, pipeline, demoProspectsAll };
}, { ttlMs: 20_000, staleMs: 10 * 60_000, key: (portalId) => portalId, shared: "crm-preview-portal-lists" });

/** After a save changed a portal's lists: the next page reads them fresh. */
export function invalidatePortalLists(portalId: string): void {
  portalLists.invalidate(portalId);
}

export async function marketPage(ctx: MarketContext, q: MarketQuery) {
  const why = unavailable(ctx, q.list);
  if (why) return { unavailable: why };
  const demo = isDemoPortal(ctx.portal.id);
  let page: { rows: Array<Record<string, unknown>>; total: number; salesVolume: number };
  if (demo && q.list === "prospects") {
    const d = await demoProspects(q);
    if ("unavailable" in d) return d;
    page = d.page;
  } else {
    const base = q.list === "prospects" ? prospectsBase(ctx) : marketBase(ctx);
    const filters = marketFilters(base, q);
    const sort = { by: SORTS[q.sort], dir: q.dir };
    const offset = (q.page - 1) * q.per;
    /*
     * From memory when this market is loaded and proven (market-memory.ts) —
     * milliseconds instead of seconds; otherwise, and for anything the memory
     * does not reproduce exactly, the database as before.
     */
    const mem = q.list === "market" ? await marketFromMemory(ctx.mls.ids, base, search) : null;
    // A name sort before this market's name order is read: the database answers, and the order starts loading.
    if (mem && sort.by === "full_name" && !mem.namesReady) requestNameOrder(ctx.mls.ids, base, search);
    const fast = mem ? searchMarket(mem, filters, sort, q.per, offset) : null;
    page = fast
      ? { rows: fast.rows as unknown as Array<Record<string, unknown>>, total: fast.total, salesVolume: fast.salesVolume }
      : await search(filters, q.per, offset, sort);
  }
  const ids = page.rows.map((r) => String(r.id));
  const lists = portalLists(ctx.portal.id);
  const [prospects, { myAgents, dnc, pipeline }] = await Promise.all([
    q.list === "prospects" ? Promise.resolve(new Set(ids))
    : demo ? lists.then(({ demoProspectsAll }) => { const s = new Set(demoProspectsAll ?? []); return new Set(ids.filter((id) => s.has(id))); })
    : inClientLists(ctx.orchClientId ?? "", ctx.orchClientId ? ids : []),
    lists,
  ]);
  const sets = listSets(myAgents, dnc, pipeline, prospects);
  const rows: MarketRow[] = page.rows.map((r) => {
    const emails = [str(r.preferred_email), str(r.enriched_email)].filter((e): e is string => !!e);
    const list = listFor({ id: String(r.id), full_name: str(r.full_name), emails }, sets);
    return {
      id: String(r.id),
      name: str(r.full_name) ?? "Unnamed agent",
      title: str(r.title),
      brokerage: str(r.brand) ?? str(r.office_name),
      officeCity: str(r.office_city),
      mostTransactedCity: str(r.most_transacted_city),
      salesVolume: num(r.sales_volume),
      units: num(r.units),
      office: str(r.office_name),
      years: num(r.est_time_in_industry_months) !== null ? Math.floor((num(r.est_time_in_industry_months) as number) / 12) : null,
      // Only an address the client already has on its own list — never the agent database's (ownListEmail).
      ...(q.per === SETUP_PAGE_SIZE && OWN_LISTS.has(list) ? { email: ownListEmail(emails, sets) } : {}),
      list,
      pill: LIST_PILL[list],
    };
  });
  return { total: page.total, salesVolume: page.salesVolume, page: q.page, pageSize: q.per, rows };
}

export type FacetKind = "brand" | "office" | "city" | "county" | "state";
type PlaceLevel = "city" | "county" | "state";
const isPlace = (k: FacetKind): k is PlaceLevel => k !== "brand" && k !== "office";

/** A filter's choices: names and agent counts; for places also how many match the search and the agents they cover. */
export type FacetResult = { unavailable: string } | { options: Array<{ v: string; n: number }>; total?: number; agents?: number };

/*
 * The choices for a Location or Brokerage filter — FAST (24 Oct, the user:
 * "this is very slow"). Counted under the other filters, a list took the
 * agent database 4 s (brokerages) to 13.5 s (cities), and again for every
 * letter typed: with the market being salespeople only, its quick per-MLS
 * lists no longer apply. So each list is the whole MARKET's (or the client's
 * prospects'), worked out once and kept 30 minutes for everyone:
 *
 *   places      every city / county / state with its agents at the chosen
 *               locations (office, most transacted) — the Database app's
 *               Location view, one count per agent per place, which is the
 *               number the filter then gives (Atlanta, GA: 16,013 both ways).
 *               Searched here, in memory, as the person types.
 *   brokerages  the Database app's brand / office lists, kept per search.
 *
 * The page asks for the city list as it opens, so the first look is quick
 * too; and after 30 minutes a list is served as it was while it refreshes
 * behind (staleMs) — nobody waits on a list twice. warmMarkets keeps the
 * lists of the markets in use loaded before anyone opens them. The other filters don't narrow these lists (the counts are the
 * market's); a filter never narrowed its own list anyway. Names and counts
 * only: no agent leaves the server.
 */
const placeList = ttlCache(async (base: Record<string, unknown>, level: PlaceLevel, kinds: readonly string[]): Promise<Array<{ v: string; n: number }>> => {
  const out: Array<{ v: string; n: number }> = [];
  for (let page = 0; page < 10; page++) {
    const d = (await rpc("fn_filter_search", {
      p_mode: "location", p_source: "all", p_filters: { ...base, locGranularity: level, locKinds: [...kinds] },
      p_sort_by: "agents", p_sort_dir: "desc", p_limit: 5000, p_offset: page * 5000,
    })) as { data?: Array<{ location?: string; agents?: number }> } | null;
    const got = d?.data ?? [];
    for (const r of got) if (r.location) out.push({ v: r.location, n: Number(r.agents) || 0 });
    if (got.length < 5000) break;
  }
  return out;
}, { ttlMs: 30 * 60_000, staleMs: 6 * 60 * 60_000, key: (base, level, kinds) => `places:${JSON.stringify(base)}:${level}:${kinds.join("+")}`, shared: "crm-preview-place-lists", inflightTimeoutMs: 180_000 });

const orgList = ttlCache(async (base: Record<string, unknown>, kind: "brand" | "office", text: string): Promise<Array<{ v: string; n: number }>> => {
  const d = await rpc("fn_facet_options", { p_type: kind, p_q: text, p_field: null, p_source: "all", p_filters: base });
  return ((Array.isArray(d) ? d : []) as Array<{ v?: unknown; n?: unknown }>)
    .map((o) => ({ v: str(o.v) ?? "", n: num(o.n) ?? 0 }))
    .filter((o) => o.v)
    .slice(0, 50);
}, { ttlMs: 30 * 60_000, staleMs: 6 * 60 * 60_000, key: (base, kind, text) => `orgs:${JSON.stringify(base)}:${kind}:${text.toLowerCase()}`, shared: "crm-preview-org-lists", inflightTimeoutMs: 120_000 });

/** A place list searched by name: up to 100, with how many places match and the agents they cover. */
function searchPlaces(all: ReadonlyArray<{ v: string; n: number }>, text: string) {
  const needle = text.trim().toLowerCase();
  const hits = needle ? all.filter((o) => o.v.toLowerCase().includes(needle)) : all;
  return { options: hits.slice(0, 100), total: hits.length, agents: hits.reduce((t, o) => t + o.n, 0) };
}

export async function marketFacet(ctx: MarketContext, q: MarketQuery, kind: FacetKind, text: string): Promise<FacetResult> {
  const why = unavailable(ctx, q.list);
  if (why) return { unavailable: why };
  if (isDemoPortal(ctx.portal.id) && q.list === "prospects") {
    // The Demo's own prospects (a short list): the choices among all of them, as the market's are.
    const ids = await demoProspectIds(mi(), DEMO_PORTAL_ID);
    if (ids === null) return { unavailable: PROSPECTS_MIGRATION };
    const rows = await agentsByIds(ids);
    const counts = new Map<string, number>();
    // A place at the chosen locations, written as the agent database writes it ("Atlanta, GA"); an agent counts once a place.
    const placeName = (p: ReturnType<typeof placeOf>) => {
      const st = (p.state ?? "").trim().toUpperCase();
      const at = kind === "city" ? p.city : kind === "county" ? p.county : st || null;
      if (!at || !at.trim()) return null;
      return kind === "city" || kind === "county" ? `${at.trim()}${st ? `, ${st}` : ""}` : at.trim();
    };
    for (const a of rows) {
      const vals = kind === "brand" ? [a.brand] : kind === "office" ? [a.office_name] : q.kinds.map((k) => placeName(placeOf(a, k)));
      for (const v of new Set(vals.filter((x): x is string => !!x && !!x.trim()))) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const all = [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([v, n]) => ({ v, n }));
    if (isPlace(kind)) return searchPlaces(all, text);
    const needle = text.trim().toLowerCase();
    return { options: all.filter((o) => o.v.toLowerCase().includes(needle)).slice(0, 50) };
  }
  const base = q.list === "prospects" ? prospectsBase(ctx) : marketBase(ctx);
  if (isPlace(kind)) return searchPlaces(await placeList(base, kind, q.kinds), text);
  return { options: await orgList(base, kind, text.replace(/[\u0000-\u001f%_]/g, " ").trim().slice(0, 60)) };
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
}, { ttlMs: 30 * 60_000, staleMs: 6 * 60 * 60_000, key: (ctx) => `options:sp:${[...ctx.mls.ids].sort().join(",")}`, shared: "crm-preview-market-options", inflightTimeoutMs: 120_000 });

/*
 * Reports › All market. Every figure is an exact count of agents in the
 * market, from the Database app's own STABLE functions:
 *   - brokerages: its brand list (fn_facet_options), an exact count per brand
 *     (checked on 16 Oct: Keller Williams in C21's market 11,863 both ways). It
 *     lists the largest 50, so how many brokerages there are is not known;
 *   - office cities: its Location view (fn_filter_search, location mode, by
 *     office, city level) — every office city with its agents, and how many
 *     cities (C21: 1,450; Atlanta 15,114, the same as filtering by office city);
 *     the agents with no office city are "Unknown";
 *   - the sales and deals bands: one count each.
 */
export interface MarketReport {
  total: number;
  groups: ReportGroup[];
  /** Every brokerage the Database app lists for the market (its largest 50), for "See all". */
  allBrokerages: GroupRow[];
}

/* Every office city in the market with its agents (the Location view's rows), and how many cities there are. */
async function officeCities(base: Record<string, unknown>): Promise<{ rows: GroupRow[]; cities: number }> {
  const rows: GroupRow[] = [];
  let cities = 0;
  for (let page = 0; page < 10; page++) {
    const d = (await rpc("fn_filter_search", {
      p_mode: "location", p_source: "all", p_filters: { ...base, locGranularity: "city", locKinds: ["office"] },
      p_sort_by: "agents", p_sort_dir: "desc", p_limit: 5000, p_offset: page * 5000,
    })) as { data?: Array<{ location?: string; agents?: number }>; totalCount?: number } | null;
    const got = d?.data ?? [];
    cities = Number(d?.totalCount) || 0;
    for (const r of got) if (r.location) rows.push({ label: r.location, n: Number(r.agents) || 0 });
    if (got.length < 5000 || rows.length >= cities) break;
  }
  return { rows, cities };
}

/*
 * The report for a portal — "why not" worked out fresh, and only a REAL report
 * cached (21 Oct). The cache is keyed by the market's MLS ids; every portal
 * with no MLS shares the empty key, so a cached "why not" named the first
 * client's record and MLS codes to the next client's Reports page and chat.
 */
export async function marketReport(ctx: MarketContext): Promise<MarketReport | { unavailable: string }> {
  const why = unavailable(ctx, "market");
  if (why) return { unavailable: why };
  return cachedReport(ctx);
}

const cachedReport = ttlCache(async (ctx: MarketContext): Promise<MarketReport> => {
  const base = marketBase(ctx);
  const [all, brands, cities] = await Promise.all([
    search(base, 1),
    rpc("fn_facet_options", { p_type: "brand", p_q: "", p_field: null, p_source: "all", p_filters: base }),
    officeCities(base),
  ]);
  const brandRows = ((Array.isArray(brands) ? brands : []) as Array<{ v: string; n: number }>).map((b) => ({ label: b.v, n: Number(b.n) || 0 }));

  const jobs: Array<() => Promise<number>> = [
    ...SALES_BANDS.map((b) => () => search({ ...base, salesVolume: rangeFilter(b) }, 1).then((r) => r.total)),
    ...DEAL_BANDS.map((b) => () => search({ ...base, closedTransactions: rangeFilter(b) }, 1).then((r) => r.total)),
  ];
  const counts = await pooled(jobs, 4);
  const salesCounts = counts.slice(0, SALES_BANDS.length);
  const dealCounts = counts.slice(SALES_BANDS.length);

  const bands = (labels: ReadonlyArray<{ label: string }>, n: number[]): GroupRow[] => {
    const m = new Map(labels.map((b, i) => [b.label, n[i]]));
    const known = n.reduce((s, x) => s + x, 0);
    if (all.total > known) m.set("Unknown", all.total - known);
    return bandRows(m, labels);
  };
  // City names as the design shows them ("Atlanta"); "City, ST" only when the market crosses states
  // (C21's has Charlotte, NC; ChuckTown's Columbia is SC, and another market's could be MO).
  const largest = cities.rows.filter((r) => r.n > 0).slice(0, 50);
  const states = new Set(largest.map((r) => (/,\s*([A-Z]{2})$/.exec(r.label)?.[1] ?? "")));
  const oneState = states.size === 1 && !states.has("");
  const placed = cities.rows.reduce((s, r) => s + r.n, 0);
  const cityRows: GroupRow[] = [
    ...largest.map((r) => ({ label: oneState ? r.label.replace(/,\s*[A-Z]{2}$/, "") : r.label, n: r.n })),
    ...(all.total > placed ? [{ label: "Unknown", n: all.total - placed }] : []),
  ];
  return {
    total: all.total,
    groups: [
      // The list stops at 50, so "of N" is only said when it is all of them.
      { title: "Current brokerage", rows: brandRows.slice(0, 8), ...(brandRows.length < 50 ? { of: { shown: Math.min(8, brandRows.length), total: brandRows.length, noun: "brokerages" } } : {}) },
      { title: "Office city", rows: cityRows, of: { shown: Math.min(8, largest.length), total: cities.cities, noun: "cities" } },
      { title: "Sales volume, last 12 months", rows: bands(SALES_BANDS, salesCounts) },
      { title: "Deals closed, last 12 months", rows: bands(DEAL_BANDS, dealCounts) },
    ],
    allBrokerages: brandRows,
  };
  // Fresh for 30 minutes; after that the last report is shown at once while a new one is counted (28 Oct, the user: "this reports section is slow" — a cold count is 20–35 s).
}, { ttlMs: 30 * 60_000, staleMs: 24 * 60 * 60_000, key: (ctx) => `report:sp:${[...ctx.mls.ids].sort().join(",")}`, shared: "crm-preview-market-report", inflightTimeoutMs: 180_000 });

/**
 * Every agent matching a page's filters, for "Select all that match" → Move to
 * (Demo Portal, 23 Oct): their ids, at most `cap`; `total` says how many there
 * are, so a list longer than the cap is refused rather than cut short.
 */
export async function matchingIds(ctx: MarketContext, q: MarketQuery, cap: number): Promise<{ unavailable: string } | { ids: string[]; total: number }> {
  const why = unavailable(ctx, q.list);
  if (why) return { unavailable: why };
  if (isDemoPortal(ctx.portal.id) && q.list === "prospects") {
    const ids = await demoProspectIds(mi(), DEMO_PORTAL_ID);
    if (ids === null) return { unavailable: PROSPECTS_MIGRATION };
    const rows: AgentRow[] = filterProspects(await agentsByIds(ids), q);
    return { ids: rows.slice(0, cap).map((a) => a.id), total: rows.length };
  }
  const base = q.list === "prospects" ? prospectsBase(ctx) : marketBase(ctx);
  const first = await search(marketFilters(base, q), Math.min(cap, 500), 0, { by: SORTS[q.sort], dir: q.dir });
  if (first.total > cap) return { ids: [], total: first.total };
  const ids = first.rows.map((r) => String(r.id));
  for (let offset = ids.length; offset < first.total; offset += 500) {
    const more = await search(marketFilters(base, q), 500, offset, { by: SORTS[q.sort], dir: q.dir });
    ids.push(...more.rows.map((r) => String(r.id)));
    if (!more.rows.length) break;
  }
  return { ids: [...new Set(ids)], total: first.total };
}

/*
 * A market into memory (its load starts if none is running; one at a time across the server), then its Location and
 * Brokerage lists and its Reports, one after another — the agent database is shared. So Reports opens counted.
 */
async function readyMarket(ctx: MarketContext, base: Record<string, unknown>): Promise<void> {
  await marketFromMemory(ctx.mls.ids, base, search);
  for (const level of ["city", "county", "state"] as const) await placeList(base, level, PLACE_KINDS).catch(() => []);
  await orgList(base, "brand", "").catch(() => []);
  await cachedReport(ctx).catch(() => null);
}

/**
 * One portal's market made ready as its client opens the portal (28 Oct): the
 * Setup wizard's first step is the team, so by the market steps a minute later
 * their filters answer from memory — even when warmMarkets' three are taken
 * (several clients onboarding at once). Reads only; a cache hit once warm.
 */
export async function warmPortalMarket(portalId: string): Promise<void> {
  const ctx = await marketContext(portalId);
  if (!ctx || unavailable(ctx, "market")) return;
  await readyMarket(ctx, marketBase(ctx));
}

/*
 * KEPT WARM (27 Oct — the client: "if we're using this during onboarding,
 * clients need to be able to see the data instantly as new filters are being
 * applied"). The markets likely to be shown — the Demo, every client in
 * Onboarding, and the portals whose Market was opened in the last two days —
 * are loaded into memory, with their name order, their Location and
 * Brokerage lists and their Reports read before anyone opens them, so the first look is as
 * fast as the hundredth. At most
 * three (market-memory holds four; one stays free for any other). Called
 * every two minutes by instrumentation (Railway only); once warm it costs a
 * cache hit and, once a minute, the one-row freshness check. Reads only.
 */
export async function warmMarkets(now = new Date()): Promise<string[]> {
  const portals: string[] = [DEMO_PORTAL_ID];
  const { data: onboarding } = await osTable("os_clients").select("mi_client_id").eq("status", "onboarding");
  for (const r of (onboarding ?? []) as unknown as Array<{ mi_client_id: string | null }>) if (r.mi_client_id) portals.push(r.mi_client_id);
  const since = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  const { data: used } = await mi().from("os_portal_usage").select("portal_id, requests").eq("kind", "market").gte("day", since);
  const byUse = new Map<string, number>();
  for (const r of (used ?? []) as Array<{ portal_id: string; requests: number }>) byUse.set(r.portal_id, (byUse.get(r.portal_id) ?? 0) + (Number(r.requests) || 0));
  portals.push(...[...byUse].sort((a, b) => b[1] - a[1]).map(([id]) => id));

  const warmed: string[] = [];
  const held: Array<{ ids: readonly string[]; base: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  for (const portalId of portals) {
    if (warmed.length >= 3) break;
    const ctx = await marketContext(portalId).catch(() => null);
    if (!ctx || unavailable(ctx, "market")) continue;
    const key = [...ctx.mls.ids].sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const base = marketBase(ctx);
    await readyMarket(ctx, base);
    // The page's badges: the portal's own lists and, for a real client, its campaign set.
    await portalLists(ctx.portal.id).catch(() => null);
    if (ctx.orchClientId) heldClientSet(ctx.orchClientId);
    held.push({ ids: ctx.mls.ids, base });
    warmed.push(ctx.portal.name);
  }
  // Then their name orders — only once no market is loading (markets first), one at a time.
  for (const m of held) requestNameOrder(m.ids, m.base, search);
  return warmed;
}
