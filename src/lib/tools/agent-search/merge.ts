/*
 * merge.ts — cross-platform agent de-duplication.
 *
 * A VERBATIM port of web/server/merge.js from the Agent Search scraper
 * (NextHire-Solutions/Scrapper @ fee0f43). Every function body below is the
 * tool's own code; the only changes are TypeScript annotations and `Row` in
 * place of bare `object`. The comments are the tool author's, kept because
 * they record why the matching is as conservative as it is.
 *
 * Why port it at all when the live service exposes GET /api/search/:id/master?
 * Because that endpoint only exists for the lifetime of an in-memory job on
 * that one container. Holding the algorithm here means the master list can be
 * rebuilt from rows the workspace already has — and, more to the point, means
 * the matching rules are under test (merge.test.ts) instead of being trusted.
 *
 * ---------------------------------------------------------------------------
 * From the original:
 *
 * Given the rows we scraped from Courted / Zillow / Realtor, find records that
 * are the SAME real-world agent and fuse them into one "master" row. A master
 * row records which platforms it came from (Sources) and why those records were
 * considered the same person (Match Basis), so the result is auditable.
 *
 * Matching is conservative — we only merge on strong, identifying signals:
 *   • phone   — same last-10 digits of any phone on the record
 *   • email   — same email address (case-insensitive)
 *   • license — same license number + same last name
 *   • name+city — same normalized full name AND same city (weaker fallback)
 */

import type { SourceId } from "./columns.ts";

export type Row = Record<string, unknown>;
export type BySource = Partial<Record<SourceId, Row[]>>;
export type SourceColumns = Partial<Record<SourceId, readonly string[]>>;

export interface MasterStats {
  totalScraped: number;
  unique: number;
  duplicatesRemoved: number;
  multiPlatform: number;
  bySource: Record<SourceId, number>;
}

export interface MasterResult {
  columns: string[];
  rows: Row[];
  stats: MasterStats;
}

const SOURCE_ORDER: SourceId[] = ["courted", "realtor", "zillow"]; // value-preference order

// Meta columns the master adds in front of the (unioned) source columns.
const META_COLUMNS = ["Sources", "Platform Count", "Match Basis"];

/**
 * The master carries EVERY column from all three source exports (deduped by
 * name), so no field from any platform is lost — plus the meta columns. Order:
 * Name, meta, then Courted's columns, then Zillow's new ones, then Realtor's.
 */
function buildColumns(sourceColumns: SourceColumns | undefined): string[] {
  const cols = sourceColumns || {};
  const order = ["Name", ...META_COLUMNS];
  const seen = new Set(order);
  for (const src of ["courted", "zillow", "realtor"] as const) {
    for (const c of cols[src] || []) {
      if (!seen.has(c)) { seen.add(c); order.push(c); }
    }
  }
  return order;
}

// For each master column, the candidate source-column names to read from (the
// three sources name the same concept differently).
const FIELD_MAP: Record<string, string[]> = {
  "Name": ["Name"],
  "First Name": ["First Name"],
  "Last Name": ["Last Name"],
  "Phone": ["Phone"],
  "Mobile Phone": ["Mobile Phone"],
  "Email": ["Email"],
  "Office / Brokerage": ["Office", "Brokerage"],
  "License Number": ["License Number", "State License"],
  "License State": ["License State", "Most Transacted State"],
  "City": ["City", "Office City", "Most Transacted City"],
  "State": ["State", "Office State", "Most Transacted State"],
  "Years Of Experience": ["Years Of Experience", "Years of Experience"],
  "Rating": ["Rating"],
  "Review Count": ["Review Count"],
  "For Sale Count": ["For Sale Count"],
  "Sold Count": ["Sold Count"],
  "Total Sales Count": ["Total Sales Count"],
  "LTM Sales Volume": ["LTM Sales Volume"],
  "Served Areas": ["Served Areas", "Service Areas"],
  "Courted Profile URL": ["Courted Profile URL"],
  "Zillow Profile URL": ["Zillow Profile URL"],
  "Realtor Profile URL": ["Realtor Profile URL"],
  "Profile Photo URL": ["Profile Photo URL"],
  "Website URL": ["Website URL"],
};

// --- normalization helpers ---
function digits(s: unknown): string { return String(s == null ? "" : s).replace(/\D/g, ""); }
function phoneKey(s: unknown): string | null { const d = digits(s); return d.length >= 10 ? d.slice(-10) : null; }
function emailKey(s: unknown): string | null {
  const e = String(s == null ? "" : s).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
const NAME_NOISE = /\b(realtor|realtors|broker|brokers|associate|associates|agent|pa|p a|llc|inc|team|group|realty|ccim|gri|abr|sfr|crs|sres|mba|epro|rsps|jr|sr|iii|ii|iv)\b/g;
function normName(s: unknown): string {
  return String(s == null ? "" : s).toLowerCase()
    .replace(/[,.'"&]/g, " ")
    .replace(NAME_NOISE, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function lastToken(name: unknown): string { const p = normName(name).split(" ").filter(Boolean); return p.length ? p[p.length - 1] : ""; }
function licenseKey(num: unknown, lastName: string): string | null {
  const n = String(num == null ? "" : num).replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (n.length < 4) return null;
  const ln = lastName || "";
  return ln ? `${ln}:${n}` : null; // require a last name to avoid cross-person collisions
}

function pick(row: Row, cols: string[]): string {
  for (const c of cols) {
    const v = row[c];
    if (v != null && String(v).trim() !== "") return String(v);
  }
  return "";
}

interface Canon {
  row: Row;
  source: SourceId;
  phones: string[];
  email: string | null;
  lic: string | null;
  name: string;
  nameCity: string | null;
}

// Build a canonical view of one source row: the keys it can match on.
function canon(row: Row, source: SourceId): Canon {
  const phones = new Set<string>();
  for (const f of ["Phone", "Mobile Phone", "Brokerage Phone"]) {
    const k = phoneKey(row[f]);
    if (k) phones.add(k);
  }
  const email = emailKey(pick(row, ["Email"]));
  const fullName = pick(row, FIELD_MAP["Name"]) || `${row["First Name"] || ""} ${row["Last Name"] || ""}`;
  const name = normName(fullName);
  const last = (pick(row, ["Last Name"]) && normName(row["Last Name"])) || lastToken(fullName);
  const lic = licenseKey(pick(row, FIELD_MAP["License Number"]), last);
  const city = normName(pick(row, FIELD_MAP["City"]));
  // name+city only when we have a real first+last (2+ tokens) — avoids merging
  // brokerage rows or single-token names by coincidence.
  const nameCity = (name.split(" ").length >= 2 && city) ? `${name}|${city}` : null;
  return { row, source, phones: [...phones], email, lic, name, nameCity };
}

// Union-Find
function makeUF(n: number) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) p[ra] = rb; };
  return { find, union };
}

/** Build the de-duplicated master list. */
export function buildMaster(bySource: BySource, sourceColumns?: SourceColumns): MasterResult {
  const nodes: Canon[] = [];
  for (const source of ["courted", "zillow", "realtor"] as const) {
    for (const row of bySource[source] || []) nodes.push(canon(row, source));
  }
  const uf = makeUF(nodes.length);

  // Index each strong key → node ids, then union nodes that share a key.
  const buckets = new Map<string, number[]>(); // key -> [ids]
  const addKey = (key: string | null, id: number) => {
    if (!key) return;
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    arr.push(id);
  };
  nodes.forEach((nd, id) => {
    for (const ph of nd.phones) addKey(`p:${ph}`, id);
    if (nd.email) addKey(`e:${nd.email}`, id);
    if (nd.lic) addKey(`l:${nd.lic}`, id);
    if (nd.nameCity) addKey(`n:${nd.nameCity}`, id);
  });
  for (const ids of buckets.values()) {
    for (let i = 1; i < ids.length; i += 1) uf.union(ids[0], ids[i]);
  }

  // Group node ids by cluster root.
  const clusters = new Map<number, number[]>();
  nodes.forEach((_, id) => {
    const root = uf.find(id);
    let arr = clusters.get(root);
    if (!arr) { arr = []; clusters.set(root, arr); }
    arr.push(id);
  });

  const rows: Row[] = [];
  let multi = 0;
  for (const ids of clusters.values()) {
    const members = ids.map((i) => nodes[i]);
    rows.push(fuse(members));
    const distinctSources = new Set(members.map((m) => m.source));
    if (distinctSources.size > 1) multi += 1;
  }

  // Stable, useful sort: multi-platform first, then by name.
  rows.sort((a, b) => (Number(b["Platform Count"]) - Number(a["Platform Count"]))
    || String(a.Name).localeCompare(String(b.Name)));

  const totalScraped = (["courted", "zillow", "realtor"] as const)
    .reduce((n, s) => n + (bySource[s] || []).length, 0);
  return {
    columns: buildColumns(sourceColumns),
    rows,
    stats: {
      totalScraped,
      unique: rows.length,
      duplicatesRemoved: totalScraped - rows.length,
      multiPlatform: multi,
      bySource: {
        courted: (bySource.courted || []).length,
        zillow: (bySource.zillow || []).length,
        realtor: (bySource.realtor || []).length,
      },
    },
  };
}

// Fuse a cluster of canonical records into one master row. Every field from
// every member is carried over; when two sources fill the SAME column name, the
// source-preference order (Courted > Realtor > Zillow) wins.
function fuse(members: Canon[]): Row {
  const ordered = [...members].sort(
    (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));

  const out: Row = {};
  for (const m of ordered) {
    for (const [k, v] of Object.entries(m.row)) {
      if (v == null || String(v).trim() === "") continue;
      if (out[k] == null || out[k] === "") out[k] = v;
    }
  }

  const sources = [...new Set(ordered.map((m) => m.source))]
    .sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  out["Sources"] = sources.join(", ");
  out["Platform Count"] = String(new Set(members.map((m) => m.source)).size);
  out["Match Basis"] = members.length > 1 ? matchBasis(members) : "";
  return out;
}

// Explain why a cluster was merged (which shared signals exist).
function matchBasis(members: Canon[]): string {
  const basis: string[] = [];
  if (sharedAcrossSources(members, (m) => m.phones)) basis.push("phone");
  if (sharedAcrossSources(members, (m) => (m.email ? [m.email] : []))) basis.push("email");
  if (sharedAcrossSources(members, (m) => (m.lic ? [m.lic] : []))) basis.push("license");
  if (sharedAcrossSources(members, (m) => (m.nameCity ? [m.nameCity] : []))) basis.push("name+city");
  return basis.length ? basis.join(", ") : "merged";
}

// True if two members from DIFFERENT sources share any value from getter.
function sharedAcrossSources(members: Canon[], getter: (m: Canon) => string[]): boolean {
  const seen = new Map<string, SourceId>(); // value -> source
  for (const m of members) {
    for (const v of getter(m)) {
      const prev = seen.get(v);
      if (prev && prev !== m.source) return true;
      if (!prev) seen.set(v, m.source);
    }
  }
  return false;
}
