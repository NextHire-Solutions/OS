import "server-only";

import { getCorofySupabase as getAgentSearchSupabase } from "@/lib/tools/corofy/supabase";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";

import { buildFilters, describeQuery, parsePlace, pickPlace, stateCode, type AgentQuery, type LocatedBy, type PlaceLevel, type PlaceOption } from "./agent-query.ts";
import { describeDbError } from "./describe-error.ts";
import { findClient } from "./identity.ts";
import { readOnly } from "./read-only.ts";

/*
 * The agent database — the Supabase project of the Railway project "Database",
 * which the onboarding app and the scraper write to as well (16 Oct: "for mcp,
 * we need to check the database project supabase as well … example of
 * question: How many agents are there in, let's say, Dallas?").
 *
 * The OS already reads this database (as "Agent Search"); what was missing was
 * a way to ask it anything but a name. Every count here comes from the
 * Database app's own search functions — fn_filter_search, fn_search_options,
 * fn_facet_options, all STABLE, so the database itself refuses a write inside
 * them — so an answer and that app's Agent Search screen agree.
 */

const db = () => readOnly(getAgentSearchSupabase());

const SOURCE = "The agent database (the Database app's Agent Search — the same count its screen shows): every agent scraped from Courted, Zillow and Realtor, not one client's list.";

type Rpc = { data: unknown; error: unknown };

async function placeOptions(level: PlaceLevel, q: string): Promise<PlaceOption[]> {
  const { data, error } = (await db().rpc("fn_search_options", { p_type: "location", p_field: level, p_q: q, p_scope: "agent", p_mls: null })) as Rpc;
  if (error) throw new Error(describeDbError(error));
  const opts = (data as { options?: Array<{ v: string; n: number }> } | null)?.options ?? [];
  return opts.map((o) => ({ v: String(o.v), n: Number(o.n) || 0 }));
}

/** A name as the Database app spells it: an exact match (any case) first, else the largest that contains it. */
async function pickOption(type: "brand" | "office", q: string): Promise<{ value: string; agents: number; others: string[] } | null> {
  const { data, error } = (await db().rpc("fn_search_options", { p_type: type, p_field: null, p_q: q, p_scope: "agent", p_mls: null })) as Rpc;
  if (error) throw new Error(describeDbError(error));
  const opts = ((Array.isArray(data) ? data : []) as Array<{ v: string; n: number }>).map((o) => ({ v: String(o.v), n: Number(o.n) || 0 }));
  if (!opts.length) return null;
  const exact = opts.find((o) => o.v.toLowerCase() === q.trim().toLowerCase());
  const pick = exact ?? [...opts].sort((a, b) => b.n - a.n)[0];
  return { value: pick.v, agents: pick.n, others: opts.filter((o) => o !== pick).slice(0, 4).map((o) => `${o.v} (${o.n})`) };
}

async function pickMls(q: string): Promise<{ id: string; code: string; name: string; agents: number } | null> {
  const { data, error } = (await db().rpc("fn_search_options", { p_type: "mls", p_field: null, p_q: q, p_scope: "agent", p_mls: null })) as Rpc;
  if (error) throw new Error(describeDbError(error));
  const opts = (Array.isArray(data) ? data : []) as Array<{ id: string; code: string; name: string; agents: number }>;
  const exact = opts.find((o) => o.code?.toLowerCase() === q.trim().toLowerCase());
  return exact ?? opts[0] ?? null;
}

async function filterSearch(mode: "agent" | "office", filters: Record<string, unknown>, sortBy: string, limit: number) {
  const { data, error } = (await db().rpc("fn_filter_search", {
    p_mode: mode, p_source: "all", p_filters: filters, p_sort_by: sortBy, p_sort_dir: "desc", p_limit: Math.max(limit, 1), p_offset: 0,
  })) as Rpc;
  if (error) throw new Error(describeDbError(error));
  const d = (data ?? {}) as { data?: Array<Record<string, unknown>>; totalCount?: number; salesVolumeTotal?: number };
  return { rows: d.data ?? [], total: Number(d.totalCount) || 0, salesVolume: Number(d.salesVolumeTotal) || 0 };
}

const AGENT_SORTS = new Set(["sales_volume", "closed_transactions", "units", "approx_gci", "avg_sale_price"]);
const OFFICE_SORTS = new Set(["agent_count", "sales_volume", "units"]);
const LOCATED: Record<string, LocatedBy[] | undefined> = { any: undefined, office: ["office"], home: ["home"], most_transacted: ["transacted"], transacted: ["transacted"] };
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface SearchAgentsArgs {
  place?: string;
  place_type?: PlaceLevel;
  located_by?: string;
  mls?: string;
  brokerage?: string;
  office?: string;
  min_sales_volume?: number;
  max_sales_volume?: number;
  min_transactions?: number;
  max_transactions?: number;
  has_email?: boolean;
  contacted?: boolean;
  replied?: boolean;
  client?: string;
  count?: "agents" | "offices";
  list?: number;
  sort_by?: string;
  group_by?: "brokerage";
}

// ---------------------------------------------------------------------------
// search_agents
// ---------------------------------------------------------------------------

export async function searchAgentsTool(a: SearchAgentsArgs) {
  const q: AgentQuery = {};
  const resolved: Record<string, unknown> = {};
  let otherPlaces: string[] = [];

  try {
    if (a.place && a.place.trim()) {
      const parsed = parsePlace(a.place, a.place_type);
      if (!parsed) return { note: `"${a.place}" is not a place the agent database can look up. Give a city, county, state or 5-digit zip.` };
      const { picked, others } = pickPlace(await placeOptions(parsed.level, parsed.name), parsed);
      if (!picked) {
        return {
          note: `No ${parsed.level} called "${a.place}" in the agent database.`,
          didYouMean: others.map((o) => `${o.v} (${o.n.toLocaleString("en-US")} agents)`),
        };
      }
      q.place = { level: parsed.level, value: picked.v };
      resolved.place = { asked: a.place, matched: picked.v, type: parsed.level };
      // The data holds misspelled places too ("Dalas, TX": 1 agent), and a typo finds them.
      if (picked.n < 25 && parsed.level !== "zip") resolved.placeNote = `Only ${picked.n} agent${picked.n === 1 ? " is" : "s are"} recorded in "${picked.v}" — if a bigger place was meant, check the spelling.`;
      if (!parsed.state) otherPlaces = others.map((o) => `${o.v}: ${o.n.toLocaleString("en-US")} agents`);
    }
    q.locatedBy = LOCATED[a.located_by ?? "any"];
    if (a.mls) {
      const m = await pickMls(a.mls);
      if (!m) return { note: `No MLS matching "${a.mls}" in the agent database.` };
      q.mlsIds = [m.id];
      resolved.mls = `${m.code} — ${m.name}`;
    }
    if (a.brokerage) {
      const b = await pickOption("brand", a.brokerage);
      if (!b) return { note: `No brokerage matching "${a.brokerage}" in the agent database.` };
      q.brands = [b.value];
      resolved.brokerage = b.value;
      if (b.others.length && b.value.toLowerCase() !== a.brokerage.trim().toLowerCase()) resolved.otherBrokerageNames = b.others;
    }
    if (a.office) {
      const o = await pickOption("office", a.office);
      if (!o) return { note: `No office matching "${a.office}" in the agent database.` };
      q.offices = [o.value];
      resolved.office = o.value;
    }
    if (a.client) {
      const { match, candidates } = await findClient(a.client);
      if (!match) return candidates.length ? { note: `"${a.client}" matches several clients — ask which.`, candidates: candidates.map((c) => c.name) } : { note: `No client named "${a.client}".` };
      if (!match.agentSearchClientId) return { client: match.name, note: "This client is not linked in the agent database, so its lists cannot be searched. That is not the same as having no agents." };
      q.clientIds = [match.agentSearchClientId];
      resolved.client = match.name;
    }
    q.minSalesVolume = n(a.min_sales_volume) ?? undefined;
    q.maxSalesVolume = n(a.max_sales_volume) ?? undefined;
    q.minTransactions = n(a.min_transactions) ?? undefined;
    q.maxTransactions = n(a.max_transactions) ?? undefined;
    if (typeof a.has_email === "boolean") q.hasEmail = a.has_email;
    if (typeof a.contacted === "boolean") q.contacted = a.contacted;
    if (typeof a.replied === "boolean") q.replied = a.replied;

    const filters = buildFilters(q);
    const offices = a.count === "offices";
    const listN = Math.min(Math.max(Math.round(n(a.list) ?? 0), 0), 25);
    const sortBy = offices ? (OFFICE_SORTS.has(a.sort_by ?? "") ? a.sort_by! : "agent_count") : AGENT_SORTS.has(a.sort_by ?? "") ? a.sort_by! : "sales_volume";

    // An agent can match by office, home and most-transacted location at once; the total counts them once.
    const splitByLocation = !offices && q.place && !q.locatedBy;
    const [main, office, home, transacted, brokerages] = await Promise.all([
      filterSearch(offices ? "office" : "agent", filters, sortBy, listN),
      splitByLocation ? filterSearch("agent", buildFilters({ ...q, locatedBy: ["office"] }), "sales_volume", 1) : null,
      splitByLocation ? filterSearch("agent", buildFilters({ ...q, locatedBy: ["home"] }), "sales_volume", 1) : null,
      splitByLocation ? filterSearch("agent", buildFilters({ ...q, locatedBy: ["transacted"] }), "sales_volume", 1) : null,
      a.group_by === "brokerage" && !offices
        ? (db().rpc("fn_facet_options", { p_type: "brand", p_q: "", p_field: null, p_source: "all", p_filters: filters }) as unknown as Promise<Rpc>)
        : null,
    ]);
    if (brokerages?.error) throw new Error(describeDbError(brokerages.error));

    return {
      counting: offices ? "offices" : "agents",
      ...resolved,
      filters: describeQuery(q, { mls: resolved.mls ? [String(resolved.mls)] : undefined, client: resolved.client as string | undefined }),
      total: main.total,
      salesVolume: offices ? undefined : Math.round(main.salesVolume),
      ...(office && home && transacted
        ? { byLocation: { office: office.total, home: home.total, mostTransacted: transacted.total, note: "An agent is in every row that matches, and once in the total." } }
        : {}),
      ...(otherPlaces.length ? { otherPlacesWithThatName: otherPlaces } : {}),
      ...(listN
        ? {
            sortedBy: sortBy,
            top: main.rows.slice(0, listN).map((r) =>
              offices
                ? { office: r.office_name, brokerage: r.brand, city: r.office_city, state: r.office_state, agents: n(r.agent_count), salesVolume: n(r.sales_volume) }
                : {
                    name: r.full_name, brokerage: r.brand, office: r.office_name, officeCity: r.office_city, officeState: r.office_state,
                    salesVolume: n(r.sales_volume), closedTransactions: n(r.closed_transactions), units: n(r.units), approxGci: n(r.approx_gci),
                    timeInIndustry: r.est_time_in_industry_raw ?? null, replied: r.has_replied === true, bounced: r.has_bounced === true,
                  },
            ),
          }
        : {}),
      ...(brokerages
        ? { topBrokerages: ((Array.isArray(brokerages.data) ? brokerages.data : []) as Array<{ v: string; n: number }>).slice(0, 15).map((b) => ({ brokerage: b.v, agents: b.n })) }
        : {}),
      source: SOURCE,
      ...(offices ? { note: "An office's agent count is everyone at that office, wherever they live." } : {}),
    };
  } catch (err) {
    return { note: `The agent database could not be searched: ${describeDbError(err)}` };
  }
}

// ---------------------------------------------------------------------------
// agent_places
// ---------------------------------------------------------------------------

const PLACE_FIELDS: Record<string, string> = { city: "city", county: "county", zip: "zip", state: "state" };

/**
 * Places ranked by how many agents (or offices) the database holds — from the
 * Database app's place index (location_options), the list its Location filter
 * offers. It is refreshed in the background; the refresh time is returned.
 * Brokerages nationally come from its brokerage list (fn_search_options).
 */
export async function agentPlacesTool(a: { by?: string; state?: string; count?: "agents" | "offices"; limit?: number }) {
  const by = a.by ?? "city";
  const limit = Math.min(Math.max(Math.round(n(a.limit) ?? 15), 1), 50);
  try {
    if (by === "brokerage") {
      if (a.state) return { note: "Brokerages within one state: use search_agents with that state as the place and group_by brokerage." };
      const { data, error } = (await db().rpc("fn_search_options", { p_type: "brand", p_field: null, p_q: "", p_scope: "agent", p_mls: null })) as Rpc;
      if (error) throw new Error(describeDbError(error));
      return {
        ranking: "brokerages by agents, nationally",
        rows: ((Array.isArray(data) ? data : []) as Array<{ v: string; n: number }>).slice(0, limit).map((b) => ({ brokerage: b.v, agents: b.n })),
        source: SOURCE,
      };
    }
    const field = PLACE_FIELDS[by];
    if (!field) return { note: `Rank by city, county, zip, state or brokerage — not "${by}".` };
    const scope = a.count === "offices" ? "office" : "agent";
    let query = db().from("location_options").select("value, state, agent_count").eq("scope", scope).eq("field", field);
    if (a.state && field !== "state") {
      const code = stateCode(a.state);
      if (!code) return { note: `"${a.state}" is not a US state.` };
      query = query.eq("state", code);
    }
    const [{ data, error }, meta] = await Promise.all([
      query.order("agent_count", { ascending: false }).limit(limit),
      db().from("location_options_meta").select("refreshed_at").limit(1),
    ]);
    if (error) throw new Error(describeDbError(error));
    return {
      ranking: `${by === "zip" ? "zip codes" : by === "county" ? "counties" : by === "state" ? "states" : "cities"}${a.state && field !== "state" ? ` in ${stateCode(a.state)}` : ""} by ${scope === "office" ? "offices" : "agents"}`,
      rows: ((data ?? []) as Array<{ value: string; agent_count: number }>).map((r) => ({ place: r.value, [scope === "office" ? "offices" : "agents"]: r.agent_count })),
      indexRefreshedAt: ((meta.data ?? []) as Array<{ refreshed_at: string | null }>)[0]?.refreshed_at ?? null,
      note: "From the Database app's place index (what its Location filter lists); an agent counts in a place when their office, home or most-transacted location is there. For one place's exact live count, use search_agents.",
      source: SOURCE,
    };
  } catch (err) {
    return { note: `The agent database could not be read: ${describeDbError(err)}` };
  }
}

// ---------------------------------------------------------------------------
// onboarding_records
// ---------------------------------------------------------------------------

/**
 * What the onboarding app keeps per client in the same database (orch_*): its
 * own status and stage, copy status, sender name, and the introductions it
 * logged. Its Stripe and campaign fields are left out on purpose — on 16 Oct
 * every client read "not paid" and no campaign status, which is not true;
 * Stripe and campaigns are client_billing and campaigns_for_client.
 */
export async function onboardingRecordsTool(a: { client?: string; status?: string }) {
  try {
    const as = db();
    let only: string | null = null;
    let clientName: string | null = null;
    if (a.client) {
      const { match, candidates } = await findClient(a.client);
      if (!match) return candidates.length ? { note: `"${a.client}" matches several clients — ask which.`, candidates: candidates.map((c) => c.name) } : { note: `No client named "${a.client}".` };
      if (!match.agentSearchClientId) return { client: match.name, note: "The onboarding app has no record linked to this client." };
      only = match.agentSearchClientId;
      clientName = match.name;
    }
    let rowsQ = as.from("orch_clients").select("id, client_name, status, stage_id, copy_status, sender_name, brand, office_name, mls, timezone, plan, weekly_target, health_status, salesperson_id, account_manager_id, created_at, updated_at").order("client_name");
    if (only) rowsQ = rowsQ.eq("id", only);
    // Paged: a request returns at most 1,000 rows, and the log grows with every introduction.
    const introPage = ({ from, to }: { from: number; to: number }) => {
      let q = as.from("orch_introductions").select("client_id, created_at");
      if (only) q = q.eq("client_id", only);
      return q.order("created_at", { ascending: false }).order("id").range(from, to);
    };
    const [rows, stages, people, introRows] = await Promise.all([
      rowsQ,
      as.from("orch_stages").select("id, name, sort"),
      as.from("orch_salespeople").select("id, name"),
      fetchAllRows<{ client_id: string; created_at: string }>(introPage),
    ]);
    const intros = { data: introRows };
    if (rows.error) throw new Error(describeDbError(rows.error));
    const stage = new Map(((stages.data ?? []) as Array<{ id: string; name: string }>).map((s) => [s.id, s.name]));
    const person = new Map(((people.data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]));
    const introCount = new Map<string, { count: number; last: string }>();
    for (const i of (intros.data ?? []) as Array<{ client_id: string; created_at: string }>) {
      const c = introCount.get(i.client_id) ?? { count: 0, last: i.created_at };
      c.count += 1;
      introCount.set(i.client_id, c);
    }
    const records = ((rows.data ?? []) as Array<Record<string, unknown>>)
      .map((r) => ({
        client: r.client_name,
        onboardingStatus: r.status,
        stage: stage.get(String(r.stage_id)) ?? null,
        copyStatus: r.copy_status,
        senderName: r.sender_name ?? null,
        brokerage: r.brand ?? null,
        office: r.office_name ?? null,
        mls: r.mls ?? null,
        timezone: r.timezone ?? null,
        plan: r.plan ?? null,
        weeklyTarget: r.weekly_target ?? null,
        status: r.health_status ?? null,
        salesperson: person.get(String(r.salesperson_id)) ?? null,
        accountManager: person.get(String(r.account_manager_id)) ?? null,
        introductionsLogged: introCount.get(String(r.id))?.count ?? 0,
        lastIntroductionLogged: introCount.get(String(r.id))?.last?.slice(0, 10) ?? null,
        created: String(r.created_at ?? "").slice(0, 10),
        updated: String(r.updated_at ?? "").slice(0, 10),
      }))
      .filter((r) => !a.status || String(r.onboardingStatus).toLowerCase() === a.status.toLowerCase() || String(r.stage ?? "").toLowerCase() === a.status.toLowerCase());
    const tally = (k: "onboardingStatus" | "stage" | "copyStatus") =>
      Object.fromEntries([...records.reduce((m, r) => m.set(String(r[k] ?? "none"), (m.get(String(r[k] ?? "none")) ?? 0) + 1), new Map<string, number>())]);
    return {
      ...(clientName ? { client: clientName } : { clients: records.length, byOnboardingStatus: tally("onboardingStatus"), byStage: tally("stage"), byCopyStatus: tally("copyStatus") }),
      records,
      stages: ((stages.data ?? []) as Array<{ name: string; sort: number }>).sort((x, y) => x.sort - y.sort).map((s) => s.name),
      note: "The onboarding app's own record (it still writes it; the OS has had no Onboarding screen since 9 Oct). status is the client's lifecycle status as the onboarding app holds it — the OS master record (client_record) is the authority. Its Stripe and campaign fields are not kept up to date there and are left out: use client_billing and campaigns_for_client.",
    };
  } catch (err) {
    return { note: `The onboarding records could not be read: ${describeDbError(err)}` };
  }
}
