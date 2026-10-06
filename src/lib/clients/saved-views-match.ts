/*
 * Which Database saved views (saved_lists) belong to which client — pure,
 * tested (client feedback, 6 Oct: "see if the clients has a saved views").
 *
 * saved_lists has no client column; a view is a client's by NAME ("Jeff Cook
 * - Greenville", "ChuckTown - Charleston, SC", "JPAR for Iron Horse") or by
 * its Client filter (filters.orchClientId(s)). A view belongs to a client when
 * every distinctive word of the client's name — or of one of its aliases —
 * appears in the view's name. Generic words (Real, Estate, Realty, Group,
 * Team, Homes, The, …) do not count, so "ChuckTown Homes Team" matches
 * "ChuckTown - Charleston, SC". Explicit links (os_client_saved_views) add a
 * view; an excluded one removes a match.
 */

const GENERIC = new Set(["the", "at", "of", "and", "for", "a", "an", "co", "inc", "llc", "real", "estate", "realty", "group", "team", "homes", "home"]);

export function words(name: string | null | undefined): string[] {
  return (name ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !GENERIC.has(w));
}

export interface ViewRow { id: string; name: string; agents: number | null; orchClientIds: string[] }
export interface ViewClient { id: string; name: string; aliases: string[]; orchClientId: string | null }
export interface ViewLink { clientId: string; viewId: string; excluded: boolean }
export interface ClientView { id: string; name: string; agents: number | null; source: "name" | "client filter" | "linked" }

function nameMatches(view: ViewRow, client: ViewClient): boolean {
  const have = new Set(words(view.name));
  return [client.name, ...client.aliases].some((n) => {
    const need = words(n);
    return need.length > 0 && need.every((w) => have.has(w));
  });
}

export function viewsByClient(clients: ViewClient[], views: ViewRow[], links: ViewLink[]): Map<string, ClientView[]> {
  const excluded = new Set(links.filter((l) => l.excluded).map((l) => `${l.clientId}|${l.viewId}`));
  const linked = links.filter((l) => !l.excluded);
  const out = new Map<string, ClientView[]>();
  for (const c of clients) {
    const mine: ClientView[] = [];
    for (const v of views) {
      if (excluded.has(`${c.id}|${v.id}`)) continue;
      const source: ClientView["source"] | null =
        linked.some((l) => l.clientId === c.id && l.viewId === v.id) ? "linked"
        : c.orchClientId && v.orchClientIds.includes(c.orchClientId) ? "client filter"
        : nameMatches(v, c) ? "name" : null;
      if (source) mine.push({ id: v.id, name: v.name, agents: v.agents, source });
    }
    out.set(c.id, mine.sort((a, b) => a.name.localeCompare(b.name)));
  }
  return out;
}
