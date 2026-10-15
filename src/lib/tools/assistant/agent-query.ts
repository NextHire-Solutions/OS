/*
 * Questions about the agent database ("how many agents are in Dallas?"),
 * turned into the filter the Database app's own Agent Search screen sends.
 *
 * Pure, so it is unit-tested; tools-phase10.ts does the reading.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATABASE APP'S FILTER, NOT A QUERY OF OUR OWN
 *
 * The agent database (Supabase project of the Railway project "Database"; the
 * onboarding app and the scraper write to the same one) answers "how many
 * agents in X" on its Agent Search screen — "15,484 Agents found · $36.0B
 * Sales volume" — through fn_filter_search. Asking the same function with the
 * same filter means the connector and that screen can never disagree, and the
 * rules nobody would re-derive correctly come with it: a place matches an
 * agent's office, home OR most-transacted location; an agent is counted once
 * however many of those match; spellings of a city are folded together.
 *
 * The filter's shape is the Database app's `Filters` (src/types/agent-filters.ts
 * there). Only the keys a question sets are sent; the function skips the rest.
 */

export type PlaceLevel = "city" | "county" | "state" | "zip";
export type LocatedBy = "office" | "home" | "transacted";

const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const CODES = new Set(Object.values(STATES));

const squash = (s: string) => s.toLowerCase().replace(/[.]/g, "").replace(/\s+/g, " ").trim();

/** A state's two-letter code from its code or its name, else null. */
export function stateCode(text: string | null | undefined): string | null {
  const t = squash(text ?? "");
  if (!t) return null;
  if (t.length === 2 && CODES.has(t.toUpperCase())) return t.toUpperCase();
  return STATES[t] ?? null;
}

export interface ParsedPlace {
  level: PlaceLevel;
  /** The place without its state: "Dallas", "Dallas" (county), "TX", "75201". */
  name: string;
  /** The state it was given with, when it was. */
  state: string | null;
}

/**
 * "Dallas" · "Dallas, TX" · "Dallas Texas" · "Dallas County, TX" · "TX" · "Texas" · "75201".
 * A whole text that is a state is the state, unless a level says otherwise.
 */
export function parsePlace(text: string, level?: PlaceLevel): ParsedPlace | null {
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) return null;
  if (level === "zip" || (!level && /^\d{5}$/.test(raw))) return { level: "zip", name: raw.slice(0, 5), state: null };

  const whole = stateCode(raw);
  if (whole && (!level || level === "state")) return { level: "state", name: whole, state: whole };
  if (level === "state") return null;

  // A trailing state: ", TX" / " TX" / ", Texas" / " New York".
  let name = raw;
  let state: string | null = null;
  const comma = raw.lastIndexOf(",");
  if (comma > 0 && stateCode(raw.slice(comma + 1))) {
    state = stateCode(raw.slice(comma + 1));
    name = raw.slice(0, comma).trim();
  } else {
    const words = raw.split(" ");
    for (const take of [2, 1]) {
      if (words.length <= take) continue;
      const tail = words.slice(-take).join(" ");
      // Without a comma, two letters count only as a capitalised code ("Dallas TX"), never "in" or "la".
      const code = tail.length === 2 ? (tail === tail.toUpperCase() ? stateCode(tail) : null) : stateCode(tail);
      if (code) {
        state = code;
        name = words.slice(0, -take).join(" ");
        break;
      }
    }
  }

  let lvl: PlaceLevel = level ?? "city";
  if (/\s+(county|parish)$/i.test(name)) {
    name = name.replace(/\s+(county|parish)$/i, "").trim();
    if (!level) lvl = "county";
  }
  return name ? { level: lvl, name, state } : null;
}

export interface PlaceOption {
  /** "Dallas, TX" — the value the Database app's filter takes. */
  v: string;
  /** Agents there. */
  n: number;
}

/**
 * The option a place means, from the Database app's own place list for the
 * name (fn_search_options). Exact names only — "Dallas" is not "Lake Dallas".
 * Without a state, the largest place of that name is taken and the others are
 * returned so the answer can name them (Dallas, GA has 972 agents).
 */
export function pickPlace(options: readonly PlaceOption[], p: ParsedPlace): { picked: PlaceOption | null; others: PlaceOption[] } {
  const byCount = [...options].sort((a, b) => b.n - a.n);
  if (p.level === "state") {
    const hit = byCount.find((o) => o.v.toUpperCase() === p.name.toUpperCase()) ?? null;
    return { picked: hit, others: [] };
  }
  if (p.level === "zip") {
    const hit = byCount.find((o) => o.v === p.name) ?? null;
    return { picked: hit, others: [] };
  }
  const want = squash(p.name);
  const split = (v: string) => {
    const at = v.lastIndexOf(",");
    return at > 0 ? { name: squash(v.slice(0, at)), state: v.slice(at + 1).trim().toUpperCase() } : { name: squash(v), state: "" };
  };
  const same = byCount.filter((o) => split(o.v).name === want);
  if (p.state) {
    const hit = same.find((o) => split(o.v).state === p.state) ?? null;
    return { picked: hit, others: hit ? [] : same.slice(0, 5) };
  }
  if (same.length === 0) return { picked: null, others: byCount.slice(0, 5) };
  return { picked: same[0], others: same.slice(1, 6) };
}

export interface AgentQuery {
  place?: { level: PlaceLevel; value: string };
  /** Which of an agent's locations may match. Empty = all three, as the Database screen defaults. */
  locatedBy?: LocatedBy[];
  mlsIds?: string[];
  brands?: string[];
  offices?: string[];
  minSalesVolume?: number;
  maxSalesVolume?: number;
  minTransactions?: number;
  maxTransactions?: number;
  hasEmail?: boolean;
  /** Ever put in a campaign (EmailBison or Instantly). */
  contacted?: boolean;
  replied?: boolean;
  /** Onboarding-app client ids (orch_clients.id): only agents in those clients' lists. */
  clientIds?: string[];
}

const ALL_LOCATIONS: LocatedBy[] = ["office", "home", "transacted"];
const num = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? String(Math.round(n)) : "");

/** The Database app's p_filters for a question — only the keys it sets. */
export function buildFilters(q: AgentQuery): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (q.place) {
    f.location = {
      field: q.place.level,
      appliesTo: q.locatedBy && q.locatedBy.length ? q.locatedBy : ALL_LOCATIONS,
      values: [q.place.value],
      excludeValues: [],
      excludeField: q.place.level,
    };
  }
  if (q.mlsIds?.length) f.mls = { include: q.mlsIds, exclude: [] };
  if (q.brands?.length || q.offices?.length) {
    f.officeSearch = { brand: { include: q.brands ?? [], exclude: [] }, office: { include: q.offices ?? [], exclude: [] } };
  }
  const vMin = num(q.minSalesVolume), vMax = num(q.maxSalesVolume);
  if (vMin || vMax) f.salesVolume = { side: "all", buckets: [], min: vMin, max: vMax };
  const tMin = num(q.minTransactions), tMax = num(q.maxTransactions);
  if (tMin || tMax) f.closedTransactions = { side: "all", buckets: [], min: tMin, max: tMax };
  const yn = (b: boolean | undefined) => (b === true ? "has" : b === false ? "missing" : "");
  if (q.hasEmail !== undefined || q.contacted !== undefined || q.replied !== undefined) {
    f.contact = { email: yn(q.hasEmail), phone: "", enriched: "", inCampaign: yn(q.contacted), replied: yn(q.replied), bounced: "" };
  }
  if (q.clientIds?.length) {
    f.orchClientIds = q.clientIds;
    f.orchClientMode = "include";
  }
  return f;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const LOCATED_WORDS: Record<LocatedBy, string> = { office: "office", home: "home", transacted: "most-transacted" };

/** The filter in words, for the answer to state what was counted. */
export function describeQuery(q: AgentQuery, names: { mls?: string[]; client?: string } = {}): string[] {
  const out: string[] = [];
  if (q.place) {
    const by = q.locatedBy && q.locatedBy.length && q.locatedBy.length < 3 ? q.locatedBy : ALL_LOCATIONS;
    out.push(`${q.place.level} ${q.place.value}, matched on the agent's ${by.map((b) => LOCATED_WORDS[b]).join(", ").replace(/, ([^,]*)$/, " or $1")} location`);
  }
  if (q.mlsIds?.length) out.push(`MLS ${names.mls?.join(", ") ?? q.mlsIds.join(", ")}`);
  if (q.brands?.length) out.push(`brokerage ${q.brands.join(", ")}`);
  if (q.offices?.length) out.push(`office ${q.offices.join(", ")}`);
  if (num(q.minSalesVolume)) out.push(`sales volume at least ${money(q.minSalesVolume!)}`);
  if (num(q.maxSalesVolume)) out.push(`sales volume at most ${money(q.maxSalesVolume!)}`);
  if (num(q.minTransactions)) out.push(`at least ${Math.round(q.minTransactions!)} closed transactions`);
  if (num(q.maxTransactions)) out.push(`at most ${Math.round(q.maxTransactions!)} closed transactions`);
  if (q.hasEmail !== undefined) out.push(q.hasEmail ? "has an email" : "no email");
  if (q.contacted !== undefined) out.push(q.contacted ? "already in a campaign" : "never in a campaign");
  if (q.replied !== undefined) out.push(q.replied ? "has replied" : "never replied");
  if (q.clientIds?.length) out.push(`in ${names.client ?? "the client"}'s lists`);
  return out;
}
