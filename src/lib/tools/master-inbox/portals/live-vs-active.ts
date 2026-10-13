/*
 * "Live portals should match the list of active clients" (13 Oct).
 *
 * The Client Portals page showed "30 live" beside "28 active", and nothing on
 * screen said whether that was a fault. It was not — one client has two
 * portals and one portal is the demo — but a person had to work that out. This
 * states it: which live portals belong to an active client, and the only two
 * ways the lists can really disagree, by name.
 *
 * Pure, so every case is tested with the code that runs.
 *
 *   live, client not active   a paused or churned client whose portal is still
 *                             on. The status sync switches these off; one here
 *                             means it has not run, or was switched back on.
 *   active, no live portal    an active client whose portal is off, has no
 *                             link, or does not exist.
 *
 * A portal no client is tied to — the demo portal, a test row — is neither:
 * it is listed apart, at the top of the page, and counted nowhere.
 */

export interface PortalRef {
  name: string;
  /** Has a link and is switched on. */
  live: boolean;
  /** The master client it belongs to, or null (demo / test). */
  clientId: string | null;
  clientName: string | null;
  clientStatus: string | null;
}

export interface ActiveClientRef {
  id: string;
  name: string;
}

export interface LiveVsActive {
  /** Live portals that belong to a client (demo and test portals excluded). */
  livePortals: number;
  activeClients: number;
  /** Active clients with more than one live portal — why the two numbers differ when everything is right. */
  several: Array<{ client: string; portals: string[] }>;
  liveNotActive: Array<{ portal: string; client: string; status: string }>;
  activeNotLive: Array<{ client: string; portals: string[] }>;
  /** Every live portal is an active client's, and every active client has one. */
  matches: boolean;
}

/** A portal with no client behind it: the demo portal, or a test row. */
export function isDemoOrTest(p: Pick<PortalRef, "clientId">): boolean {
  return p.clientId === null;
}

export function liveVsActive(portals: readonly PortalRef[], active: readonly ActiveClientRef[]): LiveVsActive {
  const owned = portals.filter((p) => !isDemoOrTest(p));
  const live = owned.filter((p) => p.live);
  const activeIds = new Set(active.map((c) => c.id));

  const liveByClient = new Map<string, string[]>();
  for (const p of live) liveByClient.set(p.clientId!, [...(liveByClient.get(p.clientId!) ?? []), p.name]);

  const byName = (a: { client: string }, b: { client: string }) => a.client.localeCompare(b.client);
  const several = active
    .filter((c) => (liveByClient.get(c.id)?.length ?? 0) > 1)
    .map((c) => ({ client: c.name, portals: [...liveByClient.get(c.id)!].sort() }))
    .sort(byName);
  const liveNotActive = live
    .filter((p) => !activeIds.has(p.clientId!))
    .map((p) => ({ portal: p.name, client: p.clientName ?? p.name, status: p.clientStatus ?? "unknown" }))
    .sort((a, b) => a.portal.localeCompare(b.portal));
  const activeNotLive = active
    .filter((c) => !liveByClient.has(c.id))
    .map((c) => ({ client: c.name, portals: owned.filter((p) => p.clientId === c.id).map((p) => p.name).sort() }))
    .sort(byName);

  return {
    livePortals: live.length,
    activeClients: active.length,
    several,
    liveNotActive,
    activeNotLive,
    matches: liveNotActive.length === 0 && activeNotLive.length === 0,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** One sentence for the page: the match, and why the numbers differ when they do. */
export function matchLine(v: LiveVsActive): string {
  if (v.activeClients === 0 && v.livePortals === 0) return "No active clients and no live portals.";
  const why = v.several.length
    ? ` ${v.livePortals} live for ${plural(v.activeClients, "active client")} because ${list(v.several.map((s) => `${s.client} has ${s.portals.length}`))}.`
    : "";
  if (v.matches) {
    return `Live portals match active clients: every one of the ${plural(v.activeClients, "active client")} has a live portal, and no paused or churned client does.${why}`;
  }
  const parts: string[] = [];
  if (v.liveNotActive.length) {
    parts.push(`${plural(v.liveNotActive.length, "portal is", "portals are")} live for a client that is not active: ${list(v.liveNotActive.map((p) => `${p.portal} (${p.status})`))}`);
  }
  if (v.activeNotLive.length) {
    parts.push(`${plural(v.activeNotLive.length, "active client has", "active clients have")} no live portal: ${list(v.activeNotLive.map((c) => c.client))}`);
  }
  return `Live portals do not match active clients — ${parts.join("; ")}.${why}`;
}
