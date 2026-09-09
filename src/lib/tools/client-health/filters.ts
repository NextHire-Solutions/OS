import type { WeeklyRow } from "./summarize.ts";

/*
 * The Weekly view's filters — a direct port of the tool's own switch statement.
 *
 * Kept out of the component so it can be tested without a browser. A pill
 * labelled "At Risk" that selects a slightly different set than the live tool's
 * is worse than no pill at all: the reader would trust it and act on it.
 *
 * The subtlety worth naming: `hidden` and `client_paused` clients are excluded
 * from EVERY filter except their own tab. That default-exclude is why the
 * headline count is 36 and not 48, and dropping it would silently re-admit
 * twelve churned and paused clients into every number on the screen.
 */

export type Filter =
  | "all" | "risk" | "ok" | "done"
  | "active" | "paused" | "inactive"
  | "client-paused" | "hidden";

export type SortCol = "leftWeek" | "campaigns";
export interface Sort { col: SortCol; dir: "asc" | "desc" }

/*
 * The tool's nine filters, in its order. Shared by all three screens so they
 * cannot drift apart.
 *
 * The last two are tabs rather than filters: hidden and client-paused clients
 * are excluded from every other view, so these are the only way to reach them.
 * Leaving them out would make churned clients unreachable from the workspace.
 *
 * "Paused" and "Client Paused" are different things and both are kept — the
 * first means the campaign stopped running, the second that somebody paused
 * the client. Collapsing them would lose a distinction the tool draws.
 */
export const FILTER_TABS: { id: Filter; label: string; cls?: string; title: string }[] = [
  { id: "all", label: "All", title: "Every active client" },
  { id: "risk", label: "At Risk", cls: "f-risk", title: "Below half their weekly target" },
  { id: "ok", label: "On Track", cls: "f-ok", title: "Between half target and full" },
  { id: "done", label: "Done", cls: "f-ok", title: "Met their weekly target" },
  { id: "active", label: "Active", title: "Has a campaign running now" },
  { id: "paused", label: "Paused", title: "Campaign launched, but not running now" },
  { id: "inactive", label: "Inactive", title: "No campaign has ever launched" },
  { id: "client-paused", label: "Client Paused", title: "Clients paused by hand" },
  { id: "hidden", label: "Churn", title: "Churned clients, hidden from every other view" },
];

export interface FilterState {
  search: string;
  filter: Filter;
  /** A plan id, or "all". Orthogonal to `filter`. */
  plan: string;
  sort: Sort | null;
}

export function applyFilters(rows: WeeklyRow[], o: FilterState): WeeklyRow[] {
  let list = rows.filter(({ client: c }) => {
    if (o.filter === "hidden") return c.hidden;
    if (o.filter === "client-paused") return c.client_paused;
    return !c.hidden && !c.client_paused;
  });

  list = list.filter(({ client: c, derived: d }) => {
    const all = [...c.campaigns, ...c.bisonCampaigns];
    const hasRunning = all.some((x) => x.status === "running");
    const hasLaunched = all.some((x) => x.status === "paused" || x.status === "finished");
    switch (o.filter) {
      case "risk": return d.status === "risk";
      case "ok": return d.status === "ok";
      case "done": return d.metTarget;
      case "active": return hasRunning;
      // Launched but not running now — matches the "Campaign Paused" badge.
      case "paused": return !hasRunning && hasLaunched;
      // Never launched — matches the "Not Active" badge.
      case "inactive": return !hasRunning && !hasLaunched;
      default: return true;
    }
  });

  const q = o.search.trim().toLowerCase();
  if (q) list = list.filter(({ client: c }) => c.name.toLowerCase().includes(q));

  if (o.plan !== "all") list = list.filter(({ client: c }) => c.plan === o.plan);

  if (o.sort) {
    const mul = o.sort.dir === "desc" ? 1 : -1;
    const score = o.sort.col === "leftWeek"
      ? (r: WeeklyRow) => r.derived.leftThisWeek
      : (r: WeeklyRow) => r.derived.campaignsAvgPct;
    // Copied before sorting: the caller's array is memoised upstream and
    // sorting it in place would mutate a value React believes is unchanged.
    list = [...list].sort((a, b) => mul * (score(b) - score(a)));
  }

  return list;
}

/** How many rows a filter-free view would show — the denominator for "showing N". */
export function visibleTotal(rows: WeeklyRow[]): number {
  return rows.filter(({ client: c }) => !c.hidden && !c.client_paused).length;
}
