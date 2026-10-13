/*
 * The Location filter on a campaign's Leads tab (13 Oct).
 *
 * Asked for by Eddy: "add location filter (office city, home city and most
 * transacted city)". Pure, so the reading and the wording are tested without a
 * browser. The filtering itself happens in SQL (analytics 097, `p_loc`) — a
 * campaign has thousands of leads and the table is paged on the server, so
 * nothing here ever filters rows.
 *
 * ---------------------------------------------------------------------------
 * THE THREE FIELDS ARE LEAD ATTRIBUTES
 *
 * A lead's custom variables arrive from EmailBison as name → value
 * (`lead_attributes`). Two of the three fields exist there today:
 *
 *   office city           "Valencia, CA"      on nearly every lead
 *   top producing city    "Palmdale, CA"      the city the agent closes most
 *                                             in — what the Database calls
 *                                             Most Transacted City
 *   home city             —                   NOT uploaded with the lists as
 *                                             of 13 Oct: no lead carries it
 *
 * Home city is wired all the same. The screen offers a field only the cities
 * that exist in the campaign, so today it says there is nothing to choose; the
 * day a list is uploaded with a "home city" variable it fills in by itself.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 *
 * Cities chosen within ONE field are alternatives (office in Valencia OR
 * Palmdale). Fields combine: a lead must match every field that has cities
 * chosen. Matching is the exact city, in any case — the cities are picked from
 * the campaign's own list, never typed freehand.
 */

export const LOCATION_FIELDS = [
  { key: "office", param: "loc_office", attribute: "office city", label: "Office city" },
  { key: "home", param: "loc_home", attribute: "home city", label: "Home city" },
  { key: "top", param: "loc_top", attribute: "top producing city", label: "Most transacted city" },
] as const;

export type LocationKey = (typeof LOCATION_FIELDS)[number]["key"];
export type LocationSelection = Record<LocationKey, string[]>;

export const NO_LOCATION: LocationSelection = { office: [], home: [], top: [] };

/** The lead attributes the screen asks cities for — the SQL's `p_names`. */
export const LOCATION_ATTRIBUTES: string[] = LOCATION_FIELDS.map((f) => f.attribute);

/*
 * The cities travel in the address of a GET request. Fifty a field keeps the
 * longest possible request to a few kilobytes — far more than a territory
 * needs, and short of the length at which a proxy starts refusing.
 */
export const MAX_CITIES_PER_FIELD = 50;

export interface CityOption {
  value: string;
  leads: number;
}

const keyOf = (city: string) => city.trim().toLowerCase();

/** Trimmed, blanks dropped, one of each whatever its case, capped. Order kept. */
export function cleanCities(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const city = v.trim();
    if (!city || seen.has(keyOf(city))) continue;
    seen.add(keyOf(city));
    out.push(city);
    if (out.length >= MAX_CITIES_PER_FIELD) break;
  }
  return out;
}

export function locationCount(selection: LocationSelection): number {
  return LOCATION_FIELDS.reduce((n, f) => n + selection[f.key].length, 0);
}

export function locationActive(selection: LocationSelection): boolean {
  return locationCount(selection) > 0;
}

/** The request's query parameters for a selection: one `loc_<field>` per city. */
export function locationParams(selection: LocationSelection): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const f of LOCATION_FIELDS) for (const city of cleanCities(selection[f.key])) out.push([f.param, city]);
  return out;
}

/*
 * The server's reading of those parameters, as the SQL's `p_loc`:
 * { "<attribute name>": ["City, ST", …] }, or null when no city is chosen.
 *
 * Only the three known parameters are read, and they map to three fixed
 * attribute names — a request cannot name an attribute of its own.
 */
export function readLocationParams(query: URLSearchParams): Record<string, string[]> | null {
  const out: Record<string, string[]> = {};
  for (const f of LOCATION_FIELDS) {
    const cities = cleanCities(query.getAll(f.param));
    if (cities.length) out[f.attribute] = cities;
  }
  return Object.keys(out).length ? out : null;
}

/** A stable string for "has the filter changed" — order within a field does not matter. */
export function locationKey(selection: LocationSelection): string {
  return LOCATION_FIELDS.map((f) => cleanCities(selection[f.key]).map(keyOf).sort().join("\u0001")).join("\u0002");
}

/** The control's label: "Location", "Location: Valencia, CA", "Location: 3 cities". */
export function locationLabel(selection: LocationSelection): string {
  const n = locationCount(selection);
  if (n === 0) return "Location";
  if (n === 1) return `Location: ${LOCATION_FIELDS.map((f) => selection[f.key][0]).find(Boolean)}`;
  return `Location: ${n} cities`;
}

/** Ticking or unticking one city, any case. Refuses a tick past the cap. */
export function toggleCity(chosen: readonly string[], city: string): string[] {
  const k = keyOf(city);
  if (chosen.some((c) => keyOf(c) === k)) return chosen.filter((c) => keyOf(c) !== k);
  if (chosen.length >= MAX_CITIES_PER_FIELD) return [...chosen];
  return [...chosen, city.trim()];
}

export function isChosen(chosen: readonly string[], city: string): boolean {
  const k = keyOf(city);
  return chosen.some((c) => keyOf(c) === k);
}

/** The cities containing what was typed, any case; everything when nothing is typed. */
export function narrowCities(options: readonly CityOption[], typed: string): CityOption[] {
  const q = typed.trim().toLowerCase();
  return q ? options.filter((o) => o.value.toLowerCase().includes(q)) : [...options];
}

/*
 * The list as the panel shows it: what is already chosen first — so an applied
 * filter is visible without scrolling 150 cities to find its ticks — then the
 * rest, most leads first (the order the server sends).
 *
 * A chosen city that is no longer in the campaign's list (its last lead was
 * removed since) is kept, with zero leads, so it can still be unticked.
 */
export function orderCities(options: readonly CityOption[], pinned: readonly string[]): CityOption[] {
  const byKey = new Map(options.map((o) => [keyOf(o.value), o]));
  const first = cleanCities(pinned).map((c) => byKey.get(keyOf(c)) ?? { value: c, leads: 0 });
  const taken = new Set(first.map((o) => keyOf(o.value)));
  return [...first, ...options.filter((o) => !taken.has(keyOf(o.value)))];
}

/*
 * The server's answer — keyed by ATTRIBUTE name, as the SQL returns it — as
 * the screen's three lists. Anything malformed is an empty list, never a
 * throw: a control that cannot open is worse than one with nothing in it.
 */
export function readLocations(body: unknown): Record<LocationKey, CityOption[]> {
  const src = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const out = { office: [], home: [], top: [] } as Record<LocationKey, CityOption[]>;
  for (const f of LOCATION_FIELDS) {
    const list = src[f.attribute];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const o = item as { value?: unknown; leads?: unknown } | null;
      if (!o || typeof o.value !== "string" || !o.value.trim()) continue;
      const leads = Number(o.leads);
      out[f.key].push({ value: o.value.trim(), leads: Number.isFinite(leads) ? leads : 0 });
    }
  }
  return out;
}
