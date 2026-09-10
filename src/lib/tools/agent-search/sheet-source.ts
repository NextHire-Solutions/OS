/*
 * sheet-source.ts — turn an "anyone with the link" Google Sheet, a pasted CSV,
 * or a raw URL list into a de-duplicated list of agent ROWS to enrich.
 *
 * A VERBATIM port of web/server/sheet-source.js (Scrapper @ fee0f43), plus
 * `detectSource` from web/server/profile-parser.js which it imports. Only
 * types were added. `fetchSheetCsv` and `resolveInput` are included but are
 * used server-side only — the Import screen calls the proxied
 * POST /api/enrich/resolve so the count it shows is the count the live
 * service will actually run.
 *
 * ---------------------------------------------------------------------------
 * From the original:
 *
 * A Google Sheet shared "anyone with the link" is readable with NO API key via
 * its CSV export endpoint:
 *   https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=<GID>
 *
 * The client's Zillow/Realtor datasets carry identifier columns (Full Name,
 * Email Address, Mobile Phone, Agent Profile <url>, State, City, County,
 * Current Brokerage). We parse the CSV GRID so those identifiers ride along on
 * each row — that's what lets reconcile.js skip agents already in the DB BEFORE
 * spending a scrape. If the input has no recognizable header (a bare list of
 * URLs), we fall back to scanning the raw text for profile URLs (identifier-less
 * rows — every one gets scraped, since we can't pre-match them).
 */

export type ProfileSource = "zillow" | "realtor";

export interface EnrichRow {
  url: string;
  source: ProfileSource;
  name?: string;
  firstName?: string;
  lastName?: string;
  brokerage?: string;
  email?: string;
  phone?: string;
  state?: string;
  city?: string;
  county?: string;
}

const SHEET_ID_RE = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;

// zillow.com/profile/<user>  |  realtor.com/realestateagents/<id-or-slug>
const PROFILE_URL_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:zillow\.com\/profile\/[^\s",'<>]+|realtor\.com\/realestateagents\/[^\s",'<>]+)/gi;

// Header label -> row field. First alias (in this order) a column matches wins,
// and each field binds to only one column. Tuned for the client's dataset
// headers but tolerant of close variants.
const HEADER_ALIASES: [string, RegExp][] = [
  ["url", /agent\s*profile|profile\s*url|\bprofile\b|zillow|realtor|\burl\b|\blink\b/i],
  ["email", /e-?mail/i],
  ["phone", /mobile|phone|cell/i],
  ["firstName", /first\s*name/i],
  ["lastName", /last\s*name/i],
  ["fullName", /full\s*name|agent\s*name|^\s*name\s*$/i],
  ["brokerage", /brokerage|broker|company|^\s*office\s*$/i],
  ["state", /\bstate\b/i],
  ["city", /\bcity\b/i],
  ["county", /\bcounty\b/i],
];

/*
 * Which source does this profile URL belong to? null = neither (skip it).
 * Verbatim from web/server/profile-parser.js.
 */
export function detectSource(rawUrl: unknown): ProfileSource | null {
  const u = String(rawUrl || "").toLowerCase();
  if (/(^|\/\/|\.)zillow\.com\/profile\//.test(u)) return "zillow";
  if (/(^|\/\/|\.)realtor\.com\/realestateagents\//.test(u)) return "realtor";
  return null;
}

/*
 * Canonical form for de-duping + matching a source URL: no protocol, no www,
 * no query/hash, no trailing slash, lowercase.
 * Verbatim from web/server/profile-parser.js.
 */
export function normalizeUrl(rawUrl: unknown): string {
  let u = String(rawUrl || "").trim().toLowerCase();
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  u = u.split(/[?#]/)[0];
  u = u.replace(/\/+$/, "");
  return u;
}

/** Rewrite a Google Sheets share/edit link to its no-auth CSV export URL. */
export function toCsvExportUrl(input: unknown): string | null {
  const s = String(input || "").trim();
  const m = s.match(SHEET_ID_RE);
  if (!m) return null;
  const gidM = s.match(/[#&?]gid=(\d+)/);
  const gid = gidM ? gidM[1] : "0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

/** Fetch a shared Google Sheet as CSV text (no API key). Throws if not public. */
export async function fetchSheetCsv(input: unknown, { timeoutMs = 30000 } = {}): Promise<string> {
  const csvUrl = toCsvExportUrl(input);
  if (!csvUrl) throw new Error("That does not look like a Google Sheets link.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(csvUrl, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Sheet fetch failed (${res.status}) — share it as "Anyone with the link".`);
    }
    const text = await res.text();
    // A private sheet 302s to a Google login HTML page instead of CSV.
    if (/<html/i.test(text.slice(0, 200))) {
      throw new Error('Sheet is not public — set sharing to "Anyone with the link".');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ── CSV grid parsing (RFC4180-ish: quoted fields, "" escapes, CR/LF) ───────────
export function parseCsvGrid(text: unknown): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\r") {
      // handled at \n
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Map a header row's cells to field->columnIndex. {} if it isn't a header. */
function mapHeader(cells: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  cells.forEach((h, idx) => {
    const label = String(h || "").trim();
    if (!label) return;
    for (const [field, re] of HEADER_ALIASES) {
      if (map[field] === undefined && re.test(label)) { map[field] = idx; break; }
    }
  });
  return map;
}

/** First Zillow/Realtor URL found in a row's cells (fallback when no url column). */
function firstUrlInCells(cells: string[]): string {
  for (const cell of cells) {
    PROFILE_URL_RE.lastIndex = 0;
    const m = PROFILE_URL_RE.exec(String(cell || ""));
    if (m) return m[0];
  }
  return "";
}

/** Normalize a found URL: ensure protocol, trim trailing punctuation. */
function tidyUrl(raw: unknown): string {
  let url = String(raw || "").trim().replace(/[)\]}>.,;'"]+$/, "");
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url.replace(/^\/\//, "")}`;
  return url;
}

/** Pull every distinct Zillow/Realtor profile URL out of arbitrary text. */
export function extractUrls(text: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  PROFILE_URL_RE.lastIndex = 0;
  while ((m = PROFILE_URL_RE.exec(String(text || "")))) {
    const url = tidyUrl(m[0]);
    const key = url.toLowerCase().replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/**
 * Parse CSV text into enrich rows. If a header row is recognized, each row keeps
 * its identifier fields (name/email/phone/state/brokerage); otherwise we fall
 * back to bare-URL rows. De-dupes on the normalized URL.
 */
export function parseDataset(text: unknown): EnrichRow[] {
  const grid = parseCsvGrid(text).filter((r) => r.some((c) => String(c || "").trim() !== ""));
  if (!grid.length) return [];

  const header = mapHeader(grid[0]);
  const headerIsReal =
    Object.keys(header).length >= 2 && !firstUrlInCells(grid[0]); // header row has no data URL

  if (!headerIsReal) {
    // No usable header — treat the whole text as a bare URL list.
    return extractUrls(text)
      .map((url) => ({ url, source: detectSource(url) }))
      .filter((r): r is EnrichRow => r.source !== null);
  }

  const out: EnrichRow[] = [];
  const seen = new Set<string>();
  const at = (cells: string[], field: string) =>
    (header[field] !== undefined ? String(cells[header[field]] || "").trim() : "");
  for (let i = 1; i < grid.length; i += 1) {
    const cells = grid[i];
    let url = tidyUrl(at(cells, "url"));
    if (!url || !detectSource(url)) url = tidyUrl(firstUrlInCells(cells));
    const source = detectSource(url);
    if (!source) continue; // no profile URL on this row -> nothing to enrich
    const key = url.toLowerCase().replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const first = at(cells, "firstName");
    const last = at(cells, "lastName");
    out.push({
      url,
      source,
      name: at(cells, "fullName") || [first, last].filter(Boolean).join(" "),
      firstName: first,
      lastName: last,
      brokerage: at(cells, "brokerage"),
      email: at(cells, "email"),
      phone: at(cells, "phone"),
      state: at(cells, "state"),
      city: at(cells, "city"),
      county: at(cells, "county"),
    });
  }
  return out;
}

export interface ResolveSummary {
  zillow: number;
  realtor: number;
  total: number;
  withIdentity: number;
}

/** Split a row list by source and count identity coverage. */
export function summarize(rows: EnrichRow[]): ResolveSummary {
  let zillow = 0;
  let realtor = 0;
  let withIdentity = 0;
  for (const r of rows) {
    if (r.source === "zillow") zillow += 1;
    else if (r.source === "realtor") realtor += 1;
    if ((r.email && r.email.trim()) || (r.phone && r.phone.trim())) withIdentity += 1;
  }
  return { zillow, realtor, total: rows.length, withIdentity };
}

/** Back-compat: tag a bare URL array with source. */
export function classify(urls: string[]) {
  const rows = urls
    .map((url) => ({ url, source: detectSource(url) }))
    .filter((r): r is EnrichRow => r.source !== null);
  return { list: rows, ...summarize(rows) };
}

/** Resolve any accepted input into enrich rows (with identifiers when present). */
export async function resolveInput(
  { sheetUrl, csv, urls }: { sheetUrl?: string; csv?: string; urls?: string[] } = {},
) {
  let text = "";
  if (sheetUrl && String(sheetUrl).trim()) text = await fetchSheetCsv(sheetUrl);
  else if (csv && String(csv).trim()) text = String(csv);
  // A raw urls[] array is just more lines to scan (identifier-less).
  if (Array.isArray(urls) && urls.length) text += `\n${urls.join("\n")}`;
  const rows = parseDataset(text);
  return { rows, list: rows, ...summarize(rows) };
}

/*
 * Bright Data is about $1.50 per 1,000 page fetches.
 * Verbatim from web/server/index.js `enrichCost`.
 */
export function enrichCost(n: number): number {
  return +(n * 0.0015).toFixed(3);
}
