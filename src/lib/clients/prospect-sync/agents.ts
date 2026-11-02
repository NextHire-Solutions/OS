import { getCorofySupabase } from "@/lib/tools/corofy/supabase";

import type { LeadAgent } from "./lead-map.ts";
import type { ShownCampaign } from "./queue.ts";

/*
 * Agents as the Database app's enrichment worker loads them for a lead (enrich-worker.mjs loadAgents), read through
 * the agent database's API: the row; its first MLS code (agent_mls → mls); its per-source values with each city put
 * through the database's own fn_norm_city (the "top producing city" variable prefers them); its per-source stats
 * (agent_source_stats). With an MLS scope (the client's market, as the team's sends from an MLS-scoped search are), the
 * stats are that scope's own sums (agent_mls_stats) and the MLS variable names its codes — the worker's "A5 scoped
 * sends". Reads only.
 */

const AGENT_COLUMNS = [
  "id", "first_name", "last_name", "full_name", "buy_side_dollar", "list_side_dollar", "office_city", "office_state",
  "preferred_phone", "preferred_email", "source_ids", "sources", "sales_volume", "approx_gci", "closed_rentals",
  "most_transacted_city", "transacted_state", "avg_sale_price", "closed_transactions", "units", "office_name", "brand",
  "enriched_email", "enriched_email_status",
].join(",");

type Row = Record<string, unknown>;
type Db = ReturnType<typeof getCorofySupabase>;

/** In parts the API's URL limit allows. */
async function byIds(db: Db, table: string, columns: string, column: string, ids: readonly string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await db.from(table).select(columns).in(column, ids.slice(i, i + 150));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as Row[]));
  }
  return out;
}

/** fn_norm_city, once per distinct value (a batch's agents share a few hundred cities at most). */
async function normalisedCities(db: Db, cities: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const todo = [...new Set(cities)];
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async (city) => {
      const { data, error } = await db.rpc("fn_norm_city", { p: city });
      if (error) throw new Error(`fn_norm_city: ${error.message}`);
      out.set(city, typeof data === "string" ? data : null);
    }));
  }
  return out;
}

/** The MLS-scoped numbers of one agent (the worker's query: sums over the scope; a units-weighted average price). */
interface Scoped { sales_volume: number; buy_side_dollar: number; list_side_dollar: number; approx_gci: number; closed_transactions: number; closed_rentals: number; units: number; avg_sale_price: number | null; mls_codes: string | null }

const SCOPED_COLUMNS = "agent_id, mls_id, sales_volume, buy_side_dollar, list_side_dollar, approx_gci, closed_transactions, closed_rentals, units, avg_sale_price";

async function scopedStats(db: Db, ids: readonly string[], scope: readonly string[]): Promise<Map<string, Scoped>> {
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await db.from("agent_mls_stats").select(SCOPED_COLUMNS).in("agent_id", ids.slice(i, i + 150)).in("mls_id", [...scope]);
    if (error) throw new Error(`agent_mls_stats: ${error.message}`);
    rows.push(...((data ?? []) as unknown as Row[]));
  }
  const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  // sum() over no non-null value is null, as in SQL.
  const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);
  const acc = new Map<string, Record<string, number | null>>();
  for (const r of rows) {
    const id = String(r.agent_id);
    const t = acc.get(id) ?? { sales_volume: null, buy_side_dollar: null, list_side_dollar: null, approx_gci: null, closed_transactions: null, closed_rentals: null, units: null, weighted: null };
    for (const k of ["sales_volume", "buy_side_dollar", "list_side_dollar", "approx_gci", "closed_transactions", "closed_rentals", "units"]) t[k] = add(t[k], n(r[k]));
    t.weighted = (t.weighted ?? 0) + (n(r.avg_sale_price) ?? 0) * (n(r.units) ?? 0);
    acc.set(id, t);
  }
  // Each agent's codes in the scope, in code order, joined as the worker joins them.
  const memberships = await byIds(db, "agent_mls", "agent_id, mls_id, mls(code)", "agent_id", [...acc.keys()]);
  const codes = new Map<string, string[]>();
  const inScope = new Set(scope);
  for (const m of memberships) {
    const code = (m.mls as { code?: unknown } | null)?.code;
    if (!inScope.has(String(m.mls_id)) || typeof code !== "string") continue;
    codes.set(String(m.agent_id), [...(codes.get(String(m.agent_id)) ?? []), code]);
  }
  const out = new Map<string, Scoped>();
  for (const [id, t] of acc) {
    const units = t.units;
    out.set(id, {
      sales_volume: t.sales_volume as number, buy_side_dollar: t.buy_side_dollar as number, list_side_dollar: t.list_side_dollar as number,
      approx_gci: t.approx_gci as number, closed_transactions: t.closed_transactions as number, closed_rentals: t.closed_rentals as number,
      units: units as number, avg_sale_price: units !== null && units > 0 ? (t.weighted ?? 0) / units : null,
      mls_codes: codes.has(id) ? [...codes.get(id)!].sort().join(" | ") : null,
    });
  }
  return out;
}

/** An agent as the run needs it: the worker's lead fields, the lead's MLS, and every MLS the agent is in (agent_mls). */
export type SyncAgent = LeadAgent & { mls_code: string | null; mls_all: string[] };

export async function loadLeadAgents(agentIds: readonly string[], o: { mlsScope?: readonly string[] | null } = {}, db: Db = getCorofySupabase()): Promise<Map<string, SyncAgent>> {
  const ids = [...new Set(agentIds)];
  if (!ids.length) return new Map();
  const scope = (o.mlsScope ?? []).filter(Boolean);
  const [agents, mls, stats, scoped] = await Promise.all([
    byIds(db, "agents", AGENT_COLUMNS, "id", ids),
    byIds(db, "agent_mls", "agent_id, mls(code)", "agent_id", ids),
    byIds(db, "agent_source_stats", "*", "agent_id", ids),
    scope.length ? scopedStats(db, ids, scope) : Promise.resolve(new Map<string, Scoped>()),
  ]);

  const mlsOf = new Map<string, string>();
  const allMls = new Map<string, string[]>();
  for (const m of mls) {
    const id = String(m.agent_id);
    const code = (m.mls as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || !code) continue;
    if (!mlsOf.has(id)) mlsOf.set(id, code);
    allMls.set(id, [...new Set([...(allMls.get(id) ?? []), code])]);
  }
  const statsOf = new Map<string, Record<string, Row>>();
  for (const s of stats) {
    const { agent_id, source, ...rest } = s;
    const by = statsOf.get(String(agent_id)) ?? {};
    by[String(source)] = { source, ...rest };
    statsOf.set(String(agent_id), by);
  }

  // Every per-source city, normalised as the worker's query does (a "city" key that is there but empty stays null).
  const cities: string[] = [];
  for (const a of agents) {
    for (const v of Object.values((a.source_ids ?? {}) as Record<string, Row | null>)) {
      if (v && typeof v === "object" && "city" in v && typeof v.city === "string") cities.push(v.city);
    }
  }
  const norm = await normalisedCities(db, cities);

  const out = new Map<string, SyncAgent>();
  for (const a of agents) {
    const raw = (a.source_ids ?? null) as Record<string, Row | null> | null;
    const sourceIds = raw
      ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v && typeof v === "object" && "city" in v ? { ...v, city: typeof v.city === "string" ? norm.get(v.city) ?? null : null } : v]))
      : null;
    const id = String(a.id);
    const sc = scoped.get(id);
    out.set(id, {
      ...(a as unknown as LeadAgent),
      id,
      source_ids: sourceIds,
      stats_by_source: statsOf.get(id) ?? null,
      mls_code: mlsOf.get(id) ?? null,
      mls_all: allMls.get(id) ?? [],
      // Scoped (the worker's payloadAgent): the scope's numbers, no per-source stats, the scope's codes as the MLS.
      ...(sc ? {
        sales_volume: sc.sales_volume, buy_side_dollar: sc.buy_side_dollar, list_side_dollar: sc.list_side_dollar, approx_gci: sc.approx_gci,
        avg_sale_price: sc.avg_sale_price, closed_rentals: sc.closed_rentals, closed_transactions: sc.closed_transactions, units: sc.units,
        stats_by_source: null, mls_code: sc.mls_codes,
      } : {}),
    });
  }
  return out;
}

/** Every row a query gives, a page at a time (a few agents can have thousands of campaign rows — 3 Nov audit). */
async function allPages(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(`${what}: ${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

/**
 * The client's campaigns the agent database shows these agents in (v_agent_campaigns: EmailBison and Instantly, as the
 * portal's Prospects list them), each EmailBison one with the address its lead there has (bison_client_leads) — a
 * removal records them, so the run looks there, under that address, whatever the campaign mappings or the agent's own
 * addresses say by the time it gets to it (3 Nov audits). Reads only; an agent in none is left out.
 */
export async function shownCampaigns(orchClientId: string, agentIds: readonly string[], db: Db = getCorofySupabase()): Promise<Map<string, ShownCampaign[]>> {
  const out = new Map<string, ShownCampaign[]>();
  const ids = [...new Set(agentIds)];
  // 20 agents a request: even an agent in dozens of campaigns rarely fills a page, so a page boundary (where a sync
  // writing meanwhile could shift rows) is seldom reached at all.
  for (let i = 0; i < ids.length; i += 20) {
    const part = ids.slice(i, i + 20);
    const [listed, leads] = await Promise.all([
      allPages((from, to) => db.from("v_agent_campaigns").select("agent_id, campaign_id, campaign_name, provider").eq("client_id", orchClientId).in("agent_id", part).order("agent_id").order("campaign_id").range(from, to), "v_agent_campaigns"),
      allPages((from, to) => db.from("bison_client_leads").select("id, agent_id, campaign_id, email").eq("client_id", orchClientId).in("agent_id", part).order("agent_id").order("campaign_id").order("id").range(from, to), "bison_client_leads"),
    ]);
    const emailsOf = new Map<string, string[]>();
    for (const r of leads) {
      const email = typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
      if (!email || typeof r.agent_id !== "string") continue;
      const key = `${r.agent_id}|${String(r.campaign_id ?? "")}`;
      emailsOf.set(key, [...new Set([...(emailsOf.get(key) ?? []), email])]);
    }
    for (const r of listed) {
      const agent = typeof r.agent_id === "string" ? r.agent_id : null;
      const id = r.campaign_id === null || r.campaign_id === undefined ? "" : String(r.campaign_id).trim();
      if (!agent || !id) continue;
      const provider = String(r.provider ?? "").trim().toLowerCase() || "emailbison";
      const list = out.get(agent) ?? [];
      if (!list.some((c) => c.provider === provider && c.id === id)) {
        const emails = provider === "emailbison" ? emailsOf.get(`${agent}|${id}`) ?? [] : [];
        list.push({ provider, id, name: typeof r.campaign_name === "string" ? r.campaign_name : null, ...(emails.length ? { emails } : {}) });
      }
      out.set(agent, list);
    }
  }
  return out;
}
