import "server-only";

import { getCorofySupabase } from "../corofy/supabase";

/*
 * Agent Search — the agent database.
 *
 * 1,173,896 agents, 177,766 offices, 1,332,890 agent↔MLS links. Every rule
 * here follows from those numbers:
 *
 *   nothing reads a whole table. Ever. Every query is a single page with an
 *   explicit range, and the count comes from PostgREST's Content-Range rather
 *   than from counting rows in JavaScript.
 *
 *   the caller cannot ask for an unbounded page. `PAGE_MAX` is enforced here,
 *   not in the UI, because the UI is not the only caller and a paste of
 *   `&limit=100000` in the address bar should not be able to pull the table.
 *
 * Measured against the live database, a page of 25 with an exact count takes
 * about 230ms and a name search about 140ms — the table is well indexed, so
 * the constraint is transfer size, not query time.
 *
 * Read-only. The four scraping workers and the MLS monitor keep writing on the
 * live service; the workspace reads what they produce.
 */

export const PAGE_SIZE = 25;
const PAGE_MAX = 100;

export interface Agent {
  id: string;
  name: string;
  title: string | null;
  officeName: string | null;
  officeCity: string | null;
  officeState: string | null;
  email: string | null;
  phone: string | null;
  salesVolume: number | null;
  closedTransactions: number | null;
  avgSalePrice: number | null;
  activeListings: number | null;
  primaryMls: string | null;
  mlsCount: number | null;
  /** Whether an email was found by enrichment, and what came back. */
  enrichedStatus: string | null;
  updatedAt: string | null;
}

export type AgentSort = "volume" | "transactions" | "name" | "recent";

export interface AgentQuery {
  q: string;
  state: string;
  sort: AgentSort;
  page: number;
}

export interface AgentPage {
  agents: Agent[];
  /** Total matching rows, from Content-Range — not the length of `agents`. */
  total: number | null;
  page: number;
  pageSize: number;
  query: AgentQuery;
  error: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
type Row = Record<string, unknown>;

/*
 * Rows as plain records.
 *
 * Without generated database types, supabase-js widens `.data` to a union that
 * includes a per-column error shape, so field access fails to compile. These
 * tables belong to another app whose migrations are not ours to track, so the
 * accessors above validate each value at runtime instead — the honest position
 * for a database we do not own.
 */
const rows = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : []);

const COLUMNS =
  "id,full_name,title,office_name,office_city,office_state,preferred_email,enriched_email," +
  "enriched_email_status,preferred_phone,sales_volume,closed_transactions,avg_sale_price," +
  "active_listings,primary_mls_code,mls_count,updated_at";

/** Parses a request's search params into a query, clamping anything hostile. */
export function parseAgentQuery(params: URLSearchParams): AgentQuery {
  const sort = params.get("sort");
  const page = Number(params.get("page") ?? 1);
  return {
    q: (params.get("q") ?? "").trim().slice(0, 80),
    state: (params.get("state") ?? "").trim().slice(0, 2).toUpperCase(),
    sort:
      sort === "transactions" || sort === "name" || sort === "recent" ? sort : "volume",
    page: Number.isFinite(page) ? Math.min(Math.max(1, Math.floor(page)), 10_000) : 1,
  };
}

export async function searchAgents(query: AgentQuery): Promise<AgentPage> {
  const pageSize = Math.min(PAGE_SIZE, PAGE_MAX);
  const from = (query.page - 1) * pageSize;

  try {
    let q = getCorofySupabase()
      .from("agents")
      .select(COLUMNS, { count: "exact" });

    if (query.q) {
      // Escaped before interpolation: a comma or parenthesis in the term would
      // otherwise be read as PostgREST filter syntax rather than as text.
      const term = query.q.replace(/[,()\\*]/g, " ").trim();
      if (term) q = q.or(`full_name.ilike.*${term}*,office_name.ilike.*${term}*`);
    }
    if (query.state) q = q.eq("office_state", query.state);

    switch (query.sort) {
      // nullsFirst: false throughout — an agent with no figure is not the
      // top-producing agent, and would otherwise head every descending sort.
      case "transactions":
        q = q.order("closed_transactions", { ascending: false, nullsFirst: false });
        break;
      case "name":
        q = q.order("full_name", { ascending: true, nullsFirst: false });
        break;
      case "recent":
        q = q.order("updated_at", { ascending: false, nullsFirst: false });
        break;
      default:
        q = q.order("sales_volume", { ascending: false, nullsFirst: false });
    }

    const { data, count, error } = await q.range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);

    const agents: Agent[] = rows(data).map((a) => ({
      id: String(a.id),
      name: str(a.full_name) ?? "Unnamed",
      title: str(a.title),
      officeName: str(a.office_name),
      officeCity: str(a.office_city),
      officeState: str(a.office_state),
      // The enriched address is the one the team actually mails, so it wins.
      email: str(a.enriched_email) ?? str(a.preferred_email),
      phone: str(a.preferred_phone),
      salesVolume: num(a.sales_volume),
      closedTransactions: num(a.closed_transactions),
      avgSalePrice: num(a.avg_sale_price),
      activeListings: num(a.active_listings),
      primaryMls: str(a.primary_mls_code),
      mlsCount: num(a.mls_count),
      enrichedStatus: str(a.enriched_email_status),
      updatedAt: str(a.updated_at),
    }));

    return { agents, total: count ?? null, page: query.page, pageSize, query, error: null };
  } catch (error) {
    return {
      agents: [],
      total: null,
      page: query.page,
      pageSize,
      query,
      error: error instanceof Error ? error.message : "Agent Search is unreachable",
    };
  }
}

export interface SavedList {
  id: string;
  name: string;
  mode: string | null;
  sourceMode: string | null;
  shared: boolean;
  count: number | null;
  cachedAt: string | null;
  updatedAt: string | null;
}

export interface AgentSearchOverview {
  agents: number | null;
  offices: number | null;
  mlsBoards: number | null;
  savedLists: SavedList[];
  error: string | null;
}

/**
 * The headline counts and the saved lists.
 *
 * Counts use `head: true`, so PostgREST returns the number in a header and no
 * rows at all — counting a million-row table costs one round trip and no
 * transfer.
 */
export async function getAgentSearchOverview(): Promise<AgentSearchOverview> {
  try {
    const sb = getCorofySupabase();
    const countOf = (table: string) =>
      sb.from(table).select("id", { count: "exact", head: true });

    const [agents, offices, mls, lists] = await Promise.all([
      countOf("agents"),
      countOf("offices"),
      countOf("mls"),
      sb
        .from("saved_lists")
        .select("id,name,mode,source_mode,is_shared,cached_count,cached_at,updated_at")
        .order("updated_at", { ascending: false })
        .limit(60),
    ]);

    const savedLists: SavedList[] = rows(lists.data).map(
      (l) => ({
        id: String(l.id),
        name: str(l.name) ?? "Untitled list",
        mode: str(l.mode),
        sourceMode: str(l.source_mode),
        shared: l.is_shared === true,
        count: num(l.cached_count),
        cachedAt: str(l.cached_at),
        updatedAt: str(l.updated_at),
      }),
    );

    return {
      agents: agents.count ?? null,
      offices: offices.count ?? null,
      mlsBoards: mls.count ?? null,
      savedLists,
      error: null,
    };
  } catch (error) {
    return {
      agents: null,
      offices: null,
      mlsBoards: null,
      savedLists: [],
      error: error instanceof Error ? error.message : "Agent Search is unreachable",
    };
  }
}
