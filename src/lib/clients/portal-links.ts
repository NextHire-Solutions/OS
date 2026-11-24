/*
 * The client record's Portal buttons (24 Nov, client: "Fix the Portal button on the client record, which currently
 * redirects users to the old Client Portal. Update the button to open the new Client Portal. Ensure the correct
 * portal is opened for the corresponding client.").
 *
 * Before: every button was the OLD login-free address, portal.brokerstaffer.com/portal/<token>, built from the portal
 * token — which also put every client's token (a credential) into the master list sent to the browser. Now: the NEW
 * portal, /crm-preview?client=<portal id>, which opens only after sign-in. No token leaves the server.
 *
 * "The correct portal": the client's own Master Inbox rows (one per market) — its linked row (os_clients.mi_client_id)
 * plus rows carrying its name or a spelling, never a row another client is linked to, never the "unknown" row, and
 * only rows that are a portal (have a token; the new portal opens nothing else). The same rule as the record's
 * "In Master Inbox" section (mi-status-mirror.ts miRowsFor), so every button on the record agrees.
 *
 * Pure: no database, so the rule is tested directly.
 */
import { newPortalPath } from "../tools/master-inbox/portals/public-url.ts";
import { keyOf } from "./roster.ts";

export interface PortalSourceRow {
  id: string;
  name: string | null;
  slug?: string | null;
  portal_enabled: boolean | null;
  portal_token: string | null;
}

export interface PortalLink {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  main: boolean;
}

export function clientPortalLinks(
  client: { id: string; name: string; aliases?: string[] | null; miClientId: string | null },
  rows: PortalSourceRow[],
  linkedElsewhere: ReadonlySet<string>,
): { url: string | null; links: PortalLink[] } {
  const keys = new Set([client.name, ...(client.aliases ?? [])].map((n) => keyOf((n ?? "").trim())).filter(Boolean));
  const seen = new Set<string>();
  const links: PortalLink[] = [];
  for (const r of rows) {
    if (seen.has(r.id) || !r.portal_token || r.slug === "unknown") continue;
    const main = !!client.miClientId && r.id === client.miClientId;
    const byName = keys.has(keyOf((r.name ?? "").trim()));
    if (!main && (!byName || linkedElsewhere.has(r.id))) continue;
    seen.add(r.id);
    links.push({ id: r.id, name: (r.name ?? "").trim() || "Portal", url: newPortalPath(r.id), enabled: r.portal_enabled !== false, main });
  }
  links.sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(b.main) - Number(a.main) || a.name.localeCompare(b.name));
  // The single "Portal" button: the client's linked portal when it is open, else its first open one.
  const open = links.filter((l) => l.enabled);
  const url = (open.find((l) => l.main) ?? open[0])?.url ?? null;
  return { url, links };
}

/** Every Master Inbox row some client is linked to, for `linkedElsewhere` (each client's own link is let through). */
export function linkedRows(clients: { id: string; miClientId: string | null }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of clients) if (c.miClientId) m.set(c.miClientId, c.id);
  return m;
}
