/*
 * The redesign's Market, Prospects and Reports pages, read from today's data —
 * the pure half (market.ts does the reading).
 *
 * WHAT "MARKET" AND "PROSPECTS" ARE HERE. The design does not say where a
 * client's market comes from, so the preview uses the two things we already
 * hold and states them on the page:
 *
 *   Market     every SALESPERSON in the agent database who belongs to an MLS
 *              on the client's record (os_clients.mls_codes — C21: FMLS,
 *              GAMLS). The record's Areas are free text ("Tampa Bay") and are
 *              not used. Salespeople only, decided here on the server (24 Oct,
 *              the user: we do not recruit team leaders or managing brokers —
 *              "we can remove this filter but in backend salesperson should be
 *              pre filled"): the page has no Title filter, and a title in a
 *              request for the market is ignored (marketScope, parseMarketQuery).
 *              BrokerStaffer's own portal is the one exception (29 Oct): its
 *              market is team leaders and managing brokers (marketTitles).
 *              A code the agent database does not have is named, never guessed
 *              (ECOAR is not silently read as ECAOR).
 *   Prospects  the agents in the client's lists in the agent database — the
 *              Database app's own "client" filter (the client's campaign leads,
 *              or its lead list when it has no campaigns yet).
 *
 * Counts and rows come from the Database app's fn_filter_search, so they are
 * the numbers its Agent Search screen shows for the same filter.
 */

import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";
import { salesVolumeOf } from "./model";

// ------------------------------------------------------- client and MLS ---

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export interface OsClientRow {
  id: string;
  name: string;
  aliases: string[] | null;
  mi_client_id: string | null;
  mls_codes: string[] | null;
  orch_client_id: string | null;
}

/**
 * The client a portal belongs to — the OS's own rule (mi-status-mirror.ts
 * miRowsFor): the client linked to the portal, else the one whose name or an
 * alias is the portal's name ("Properties & Estates Orlando").
 */
export function clientForPortal(portal: { id: string; name: string }, clients: readonly OsClientRow[]): OsClientRow | null {
  const linked = clients.find((c) => c.mi_client_id === portal.id);
  if (linked) return linked;
  const key = norm(portal.name);
  if (!key) return null;
  const named = clients.filter((c) => [c.name, ...(c.aliases ?? [])].some((n) => norm(n) === key));
  return named.length === 1 ? named[0] : null;
}

export interface MlsRow {
  id: string;
  code: string;
  name: string;
  aliases: string[] | null;
}

/** The client's MLS codes as the agent database's MLS ids — exact code or alias, case and punctuation aside. */
export function resolveMls(codes: readonly string[] | null | undefined, rows: readonly MlsRow[]) {
  const index = new Map<string, MlsRow>();
  for (const r of rows) {
    index.set(norm(r.code), r);
    for (const a of r.aliases ?? []) index.set(norm(a), r);
  }
  const matched: MlsRow[] = [];
  const unmatched: string[] = [];
  for (const c of codes ?? []) {
    const hit = index.get(norm(c));
    if (hit) { if (!matched.includes(hit)) matched.push(hit); } else if (c.trim()) unmatched.push(c.trim());
  }
  return { ids: matched.map((m) => m.id), matched: matched.map((m) => ({ code: m.code, name: m.name })), unmatched };
}

// -------------------------------------------------------------- filters ---

export type MarketList = "market" | "prospects";

/** The title every client's market holds (see the top of this file). */
export const MARKET_TITLE = "Salesperson";

/** BrokerStaffer's own portal (Master Inbox `clients`) — the house account (viewer-rules.ts re-exports it). */
export const BROKERSTAFFER_PORTAL_ID = "54322dcf-7392-4022-918c-990ebc8469b8";

/*
 * BrokerStaffer's own portal is its own CRM, and what it recruits is clients — team leaders and managing brokers — so
 * its market is them (29 Oct, the user: "Team Leader and Managing Broker instead of salesperson. That is the only portal
 * where this would be the case."). An agent with either title is in it ("Salesperson, Team Leader" too).
 */
export const BROKERSTAFFER_MARKET_TITLES: readonly string[] = ["Team Leader", "Managing Broker"];

/** The titles a portal's market holds: salespeople, but for BrokerStaffer's own portal. */
export function marketTitles(portalId: string | null | undefined): readonly string[] {
  return portalId === BROKERSTAFFER_PORTAL_ID ? BROKERSTAFFER_MARKET_TITLES : [MARKET_TITLE];
}

/** The salesperson market — the only one held in memory (market-memory.ts keys a market by its MLSs alone). */
export function salespeopleOnly(titles: readonly string[]): boolean {
  return titles.length === 1 && titles[0] === MARKET_TITLE;
}

/** Who a market is, in words: "every salesperson", "every team leader and managing broker". */
export function marketWho(titles: readonly string[]): string {
  const t = titles.map((x) => x.toLowerCase());
  return `every ${t.length > 1 ? `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}` : t[0] ?? "salesperson"}`;
}

/** The Database app's p_filters for a client's market: the agents with its titles (salespeople) in its MLSs. */
export function marketScope(mlsIds: readonly string[], titles: readonly string[] = [MARKET_TITLE]): Record<string, unknown> {
  return { mls: { include: [...mlsIds], exclude: [] }, title: { include: [...titles], exclude: [] } };
}

/** The design's filter chips, as presets (the values a chip offers), so nothing free-form reaches the database. */
export const VOLUME_PRESETS = [1_000_000, 2_000_000, 5_000_000, 10_000_000] as const;
export const UNIT_PRESETS = [1, 4, 10, 20] as const;
export const YEAR_PRESETS = [1, 2, 5, 10] as const;
export const TITLES = ["Salesperson", "Team Leader", "Managing Broker"] as const;
export const PAGE_SIZE = 50;
/** The Setup wizard's tables show eight agents a page (Setup-2-Agents, Setup-4-Target). */
export const SETUP_PAGE_SIZE = 8;
/*
 * How deep one search may go: 1,000 agents (20 pages of 50, 125 of 8). Past
 * that, narrow the filters — paging through a whole market is what a scraper
 * does (the user, 17 Oct: no one may extract the data; lib/crm-preview/data-guard.ts).
 */
export const MAX_ROWS = 1_000;
export const maxPage = (per: number) => Math.floor(MAX_ROWS / per);

/*
 * Sorting (21 Oct, Eddy: "alphabetical sorting for names and brokerages") — the
 * Database app's own sort keys (fn_agent_sort_col). Names and places read A→Z
 * on the first click; figures largest first.
 */
export const SORTS = {
  name: "full_name",
  brokerage: "brand",
  officeCity: "office_city",
  transactedCity: "most_transacted_city",
  title: "title",
  volume: "sales_volume",
  units: "units",
} as const;
export type SortKey = keyof typeof SORTS;
export const FIRST_DIR: Record<SortKey, "asc" | "desc"> = { name: "asc", brokerage: "asc", officeCity: "asc", transactedCity: "asc", title: "asc", volume: "desc", units: "desc" };

export interface Range {
  min: number | null;
  max: number | null;
}

/** Brokerages and offices picked at once (Eddy: "searching multiple cities and brokerages at once"). */
export const MAX_PICKS = 20;
/** Places picked at once, included and excluded together — the Database app's Location cap. */
export const MAX_PLACES = 50;

/*
 * Which of an agent's places a Location filter looks at (24 Oct — the user
 * wants the Database app's Location filter, on the columns the client's
 * design shows: "we do not have home location column so we do not want this
 * here"): the office's place and where the agent sold most — Market's Office
 * city and Most transacted city. Both unless narrowed.
 */
export const PLACE_KINDS = ["office", "transacted"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

export interface MarketQuery {
  list: MarketList;
  page: number;
  /** Rows a page: 50, or the Setup wizard's 8. */
  per: number;
  q: string;
  /** Ranges, min and max (21 Oct, Eddy: "range filters for sales volume and number of units"). */
  volume: Range;
  units: Range;
  years: Range;
  brokerages: string[];
  /** Office names (the Setup wizard's Office filter, 23 Oct). */
  offices: string[];
  cities: string[];
  counties: string[];
  /** States (the Database app's Location levels are city, county and state here — 24 Oct). */
  states: string[];
  /** The agent's places a Location filter looks at: office, most transacted. */
  kinds: PlaceKind[];
  /** Titles, any of them (the page starts on Salesperson). */
  titles: string[];
  /*
   * Left out (23 Oct, the client likes the Database app's include / exclude):
   * an agent at any of these brokerages or offices, in any of these places,
   * or with any of these titles is not shown. An agent with no brokerage,
   * place or title on record stays — "not in Atlanta" does not drop someone
   * whose city is unknown (the Database app's rule, fn_agent_where).
   */
  not: { brokerages: string[]; offices: string[]; cities: string[]; counties: string[]; states: string[]; titles: string[] };
  sort: SortKey;
  dir: "asc" | "desc";
}

/** A request's query string, held to what the page can send: bounded numbers, short texts, known sorts. */
export function parseMarketQuery(p: URLSearchParams): MarketQuery {
  const clean = (v: string | null, max: number) => (v ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) || null;
  const amount = (k: string, cap: number) => {
    const raw = p.get(k);
    if (raw === null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= cap ? n : null;
  };
  const range = (min: string, max: string, cap: number): Range => ({ min: amount(min, cap), max: amount(max, cap) });
  const many = (k: string, cap = MAX_PICKS) => [...new Set(p.getAll(k).map((v) => clean(v, 120)).filter((v): v is string => !!v))].slice(0, cap);
  const places = (k: string) => many(k, MAX_PLACES);
  const states = (k: string) => places(k).filter((st) => /^[A-Za-z]{2}$/.test(st)).map((st) => st.toUpperCase());
  const kinds = PLACE_KINDS.filter((x) => p.getAll("kind").includes(x));
  const page = Math.floor(Number(p.get("page")));
  const list: MarketList = p.get("list") === "prospects" ? "prospects" : "market";
  // Titles, only the three. A market's own titles are its scope (marketScope): marketFilters lets a title pick only narrow a
  // market that holds several — BrokerStaffer's own (29 Oct) — and ignores it on a salesperson market, so none is ever widened.
  const titles = (k: string) => many(k).filter((t) => (TITLES as readonly string[]).includes(t));
  const per = p.get("per") === String(SETUP_PAGE_SIZE) ? SETUP_PAGE_SIZE : PAGE_SIZE;
  const sortRaw = p.get("sort") ?? "";
  const sort: SortKey = sortRaw in SORTS ? (sortRaw as SortKey) : "volume";
  const dirRaw = p.get("dir");
  return {
    list,
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, maxPage(per)) : 1,
    per,
    q: clean(p.get("q"), 80) ?? "",
    volume: range("minVolume", "maxVolume", 100_000_000_000),
    units: range("minUnits", "maxUnits", 100_000),
    years: range("minYears", "maxYears", 80),
    brokerages: many("brokerage"),
    offices: many("office"),
    cities: places("city"),
    counties: places("county"),
    states: states("state"),
    // None named: both (a filter that looked at no place would show everyone).
    kinds: kinds.length ? kinds : [...PLACE_KINDS],
    titles: titles("title"),
    not: { brokerages: many("xbrokerage"), offices: many("xoffice"), cities: places("xcity"), counties: places("xcounty"), states: states("xstate"), titles: titles("xtitle") },
    sort,
    dir: dirRaw === "asc" || dirRaw === "desc" ? dirRaw : FIRST_DIR[sort],
  };
}

const set = (r: Range) => r.min !== null || r.max !== null;
const ends = (r: Range) => ({ min: r.min === null ? "" : String(r.min), max: r.max === null ? "" : String(r.max) });

/** The Database app's p_filters for a market page: its base (MLS or client) plus the filters. */
export function marketFilters(base: Record<string, unknown>, q: MarketQuery): Record<string, unknown> {
  const f: Record<string, unknown> = { ...base };
  if (set(q.volume)) f.salesVolume = { side: "all", buckets: [], ...ends(q.volume) };
  if (set(q.units)) f.closedUnits = { side: "all", buckets: [], ...ends(q.units) };
  // In YEARS: fn_agent_where turns them into months itself (Database 0109). Sending months filtered 2+ years as 24+ (21 Oct).
  if (set(q.years)) f.estTimeInIndustry = { buckets: [], ...ends(q.years) };
  const x = q.not;
  if (q.brokerages.length || q.offices.length || x.brokerages.length || x.offices.length) {
    f.officeSearch = { brand: { include: [...q.brokerages], exclude: [...x.brokerages] }, office: { include: [...q.offices], exclude: [...x.offices] } };
  }
  // Cities, counties and states in one location filter, each value keeping its own level — any of them matches, none of the left-out ones —
  // at the agent's office and/or most transacted location (the Database app's way).
  const levels = (c: { cities: string[]; counties: string[]; states: string[] }) => [
    ...c.cities.map((v) => ({ f: "city", v })), ...c.counties.map((v) => ({ f: "county", v })), ...c.states.map((v) => ({ f: "state", v })),
  ];
  const places = levels(q);
  const notPlaces = levels(x);
  if (places.length || notPlaces.length) {
    const field = (places[0] ?? notPlaces[0]).f;
    f.location = { field, appliesTo: [...q.kinds], values: places, excludeValues: notPlaces, excludeField: (notPlaces[0] ?? places[0]).f };
  }
  const scope = (base.title as { include?: string[] } | undefined)?.include;
  if (scope) {
    /*
     * A market's titles (marketScope): a title pick narrows them, never widens — only where the market holds several
     * (BrokerStaffer's own portal: team leaders and managing brokers, 29 Oct). A salesperson market ignores title picks.
     */
    const inc = q.titles.filter((t) => scope.includes(t));
    const exc = x.titles.filter((t) => scope.includes(t));
    if (scope.length > 1 && (inc.length || exc.length)) f.title = { include: inc.length ? inc : [...scope], exclude: exc };
  } else if (q.titles.length || x.titles.length) f.title = { include: [...q.titles], exclude: [...x.titles] };
  /*
   * "Search agents": the agents whose name contains the text, any case — the
   * Database app's own name filter (fn_agent_where `name`: full_name ILIKE
   * %text%). It used to send nameQuery, which only moves matches first and,
   * in a market scoped per MLS, is ignored under the volume and units orders
   * (fn_filter_search 0119): typing a name changed nothing (27 Oct).
   */
  if (q.q) f.name = { include: [q.q], exclude: [] };
  return f;
}

// ------------------------------------------------------------ the bands ---

/** The design's bands (Reports), with the ranges each one counts. */
export const SALES_BANDS: ReadonlyArray<{ label: string; min: number | null; max: number | null }> = [
  { label: "Under $1M", min: null, max: 999_999.99 },
  { label: "$1M to $2.5M", min: 1_000_000, max: 2_499_999.99 },
  { label: "$2.5M to $5M", min: 2_500_000, max: 4_999_999.99 },
  { label: "$5M to $10M", min: 5_000_000, max: 9_999_999.99 },
  { label: "$10M to $25M", min: 10_000_000, max: 24_999_999.99 },
  { label: "$25M+", min: 25_000_000, max: null },
];
export const DEAL_BANDS: ReadonlyArray<{ label: string; min: number | null; max: number | null }> = [
  { label: "0 to 2", min: null, max: 2 },
  { label: "3 to 5", min: 3, max: 5 },
  { label: "6 to 10", min: 6, max: 10 },
  { label: "11 to 20", min: 11, max: 20 },
  { label: "21 or more", min: 21, max: null },
];

export function bandOf(n: number | null, bands: ReadonlyArray<{ label: string; min: number | null; max: number | null }>): string {
  if (n === null || !Number.isFinite(n)) return "Unknown";
  const hit = bands.find((b) => (b.min === null || n >= b.min) && (b.max === null || n <= b.max));
  return hit?.label ?? "Unknown";
}

export const rangeFilter = (b: { min: number | null; max: number | null }) => ({
  side: "all", buckets: [], min: b.min === null ? "" : String(b.min), max: b.max === null ? "" : String(b.max),
});

export interface GroupRow {
  label: string;
  n: number;
}

/** Counts in the bands' order, then Unknown when there is any. */
export function bandRows(counts: Map<string, number>, bands: ReadonlyArray<{ label: string }>): GroupRow[] {
  const rows = bands.map((b) => ({ label: b.label, n: counts.get(b.label) ?? 0 }));
  const unknown = counts.get("Unknown") ?? 0;
  return unknown > 0 ? [...rows, { label: "Unknown", n: unknown }] : rows;
}

// ----------------------------------------------------- interested only ---

const cfOf = (e: Pick<PipelineEntry, "lead_detail">) => ((e.lead_detail as { custom_fields?: Record<string, unknown> } | null)?.custom_fields ?? {}) as Record<string, unknown>;

function field(cf: Record<string, unknown>, pattern: RegExp): string | null {
  for (const [k, v] of Object.entries(cf)) {
    if (pattern.test(k) && v != null && typeof v !== "object") {
      const s = String(v).trim();
      if (s && s !== "null") return s;
    }
  }
  return null;
}

/** A lead's closed deals in the last 12 months, from its details ("Closed transactions": "5"). */
export function dealsOf(e: Pick<PipelineEntry, "lead_detail">): number | null {
  const raw = field(cfOf(e), /^closed\s*_?transactions?$|^closedtransactions$/i);
  if (raw === null) return null;
  const n = Number(raw.replace(/[^0-9.]/g, ""));
  return raw.replace(/[^0-9.]/g, "") !== "" && Number.isFinite(n) ? n : null;
}

/** A lead's office city: "Office city" from its details, else its location, without the state. */
export function officeCityOf(e: Pick<PipelineEntry, "lead_detail" | "lead_location">): string | null {
  const raw = field(cfOf(e), /^office\s*_?city$|^officecity$/i) ?? e.lead_location;
  if (!raw) return null;
  const city = raw.split(",")[0].trim();
  return city ? city.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

/** Every group, largest first (the page shows the top ones and "See all"). */
function topRows(values: Array<string | null>): { rows: GroupRow[]; groups: number; unknown: number } {
  const counts = new Map<string, number>();
  let unknown = 0;
  const shown = new Map<string, string>();
  for (const v of values) {
    const key = v ? v.trim().toLowerCase() : "";
    if (!key) { unknown += 1; continue; }
    if (!shown.has(key)) shown.set(key, v!.trim());
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => ({ label: shown.get(k)!, n }));
  return { rows, groups: rows.length, unknown };
}

export interface ReportGroup {
  title: string;
  rows: GroupRow[];
  /** "Top 8 of 41 brokerages" — how many groups there are, when that is known. */
  of?: { shown: number; total: number; noun: string };
}

/** Reports › Interested only: the client's pipeline, by the design's four groups. */
export function interestedReport(entries: ReadonlyArray<Pick<PipelineEntry, "lead_detail" | "lead_location" | "current_brokerage">>, top = 8): { total: number; groups: ReportGroup[] } {
  const brokerage = topRows(entries.map((e) => e.current_brokerage));
  const city = topRows(entries.map((e) => officeCityOf(e)));
  const sales = new Map<string, number>();
  const deals = new Map<string, number>();
  for (const e of entries) {
    const s = bandOf(salesVolumeOf(e), SALES_BANDS);
    sales.set(s, (sales.get(s) ?? 0) + 1);
    const d = bandOf(dealsOf(e), DEAL_BANDS);
    deals.set(d, (deals.get(d) ?? 0) + 1);
  }
  const withUnknown = (t: { rows: GroupRow[]; unknown: number }) => (t.unknown > 0 ? [...t.rows, { label: "Unknown", n: t.unknown }] : t.rows);
  return {
    total: entries.length,
    groups: [
      { title: "Current brokerage", rows: withUnknown(brokerage), of: { shown: Math.min(top, brokerage.groups), total: brokerage.groups, noun: "brokerages" } },
      { title: "Office city", rows: withUnknown(city), of: { shown: Math.min(top, city.groups), total: city.groups, noun: "cities" } },
      { title: "Sales volume, last 12 months", rows: bandRows(sales, SALES_BANDS) },
      { title: "Deals closed, last 12 months", rows: bandRows(deals, DEAL_BANDS) },
    ],
  };
}

// ------------------------------------------------------------ the lists ---

export type ListName = "DNC List" | "My Agents" | "In your pipeline" | "Prospects" | "Not on a list";

/** The design's pill for each list (Market-Row / Market-Selected screens). */
export const LIST_PILL: Record<ListName, string> = {
  "DNC List": "p-no",
  "My Agents": "p-hi",
  "In your pipeline": "p-int",
  Prospects: "p-iv",
  "Not on a list": "p-nu",
};

export interface ListSets {
  prospects: ReadonlySet<string>;
  myAgentEmails: ReadonlySet<string>;
  myAgentNames: ReadonlySet<string>;
  dncEmails: ReadonlySet<string>;
  dncNames: ReadonlySet<string>;
  dncDomains: ReadonlySet<string>;
  pipelineEmails: ReadonlySet<string>;
  pipelineNames: ReadonlySet<string>;
}

export const personKey = (name: string | null | undefined) => (name ?? "").toLowerCase().replace(/[^a-z]/g, "");

/**
 * Which of the client's lists an agent is on, as the design's List column
 * shows it: DNC, then My Agents, then their pipeline, then Prospects. A list
 * entry with an email matches on the email; one without matches on the full
 * name (many clients' My Agents rows carry names only).
 */
export function listFor(agent: { id: string; full_name: string | null; emails: string[] }, s: ListSets): ListName {
  const emails = agent.emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  const name = personKey(agent.full_name);
  const domains = emails.map((e) => e.split("@")[1]).filter(Boolean);
  if (emails.some((e) => s.dncEmails.has(e)) || (name && s.dncNames.has(name)) || domains.some((d) => s.dncDomains.has(d))) return "DNC List";
  if (emails.some((e) => s.myAgentEmails.has(e)) || (name && s.myAgentNames.has(name))) return "My Agents";
  if (emails.some((e) => s.pipelineEmails.has(e)) || (name && s.pipelineNames.has(name))) return "In your pipeline";
  if (s.prospects.has(agent.id)) return "Prospects";
  return "Not on a list";
}

/**
 * The one address the client already holds for this agent: an EXACT match on
 * one of its own lists (My Agents, DNC, its pipeline), as that list has it —
 * never from a name or company-domain match, and never another of the
 * agent's addresses (22 Oct audit: a DNC company domain showed the email of
 * every agent at that company). Null when there is none.
 */
export function ownListEmail(emails: readonly string[], s: ListSets): string | null {
  for (const e of emails.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (s.dncEmails.has(e) || s.myAgentEmails.has(e) || s.pipelineEmails.has(e)) return e;
  }
  return null;
}

/** The sets above from the client's My Agents, DNC and pipeline. Names only from entries with no email. */
export function listSets(
  myAgents: ReadonlyArray<{ name: string; email: string | null }>,
  dnc: ReadonlyArray<{ kind: "agent" | "company"; name: string; email: string | null; domain: string | null }>,
  pipeline: ReadonlyArray<{ lead_name: string | null; lead_email: string | null }>,
  prospects: ReadonlySet<string>,
): ListSets {
  const email = (e: string | null) => (e ?? "").trim().toLowerCase();
  const names = (rows: ReadonlyArray<{ name: string | null; email: string | null }>) =>
    new Set(rows.filter((r) => !email(r.email)).map((r) => personKey(r.name)).filter((k) => k.length >= 5));
  const people = dnc.filter((d) => d.kind === "agent");
  const leads = pipeline.map((p) => ({ name: p.lead_name, email: p.lead_email }));
  return {
    prospects,
    myAgentEmails: new Set(myAgents.map((a) => email(a.email)).filter(Boolean)),
    myAgentNames: names(myAgents),
    dncEmails: new Set(people.map((d) => email(d.email)).filter(Boolean)),
    dncNames: names(people),
    dncDomains: new Set(dnc.filter((d) => d.kind === "company").map((d) => (d.domain ?? "").trim().toLowerCase().replace(/^@/, "")).filter(Boolean)),
    pipelineEmails: new Set(leads.map((l) => email(l.email)).filter(Boolean)),
    pipelineNames: names(leads),
  };
}
