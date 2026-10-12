/*
 * Deleting ONE portal — the rules, with no database attached.
 *
 * Pure, so every combination is tested with the code that runs
 * (delete-portal-rule.test.ts). delete-portal.ts does the reading and writing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * Clients → Delete removes a CLIENT, at a chosen scope, and can take the
 * portal with it (delete.ts). This is the other act, asked for on 13 Oct
 * ("Add the ability to delete client portals"): remove a PORTAL and leave the
 * client exactly where it is — in the OS, in billing, in its campaigns, in
 * every other tool. The user's decision, word for word: "Portal only, client
 * stays", admins only.
 *
 * A portal is a row of Master Inbox's `clients` table. Deleting it cascades
 * its pipeline, agents, do-not-contact list, team, stages, its list in the
 * inbox's Clients panel and its campaign routing choices; conversations are
 * kept and lose their client tag. Its link is a random token that cannot be
 * recreated, so anyone holding it gets a 404 from then on.
 *
 * ---------------------------------------------------------------------------
 * THE THREE REFUSALS
 *
 *   the demo portal   it backs the live demonstration people are shown; the
 *                     user's standing rule is that it is never deleted
 *   the Unknown row   Master Inbox's bucket for replies it could not place
 *   a LIVE portal     somebody outside may be using it right now. Switching
 *                     it off is one click, reversible, and a decision; this
 *                     makes it a separate one from the delete.
 */

export interface PortalFacts {
  id: string;
  name: string;
  slug: string | null;
  portalToken: string | null;
  portalEnabled: boolean | null;
}

/** The same key the status feed matches portals by: letters and digits only. */
export const nameKey = (x: string): string => (x ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** A portal someone can open right now: it has a link and is not switched off. */
export function portalIsLive(p: Pick<PortalFacts, "portalToken" | "portalEnabled">): boolean {
  return Boolean(p.portalToken && p.portalToken.trim()) && p.portalEnabled !== false;
}

/** Why this row may never be deleted, or null. Matched by slug AND by name. */
export function protectedReason(p: Pick<PortalFacts, "name" | "slug">): string | null {
  if ((p.slug ?? "") === "unknown" || nameKey(p.name) === "unknown") {
    return "This is Master Inbox's bucket for replies it could not place — it is not a client portal and cannot be deleted.";
  }
  if ((p.slug ?? "") === "demo-portal" || nameKey(p.name) === "demoportal") {
    return "Demo Portal is protected — it backs the live demo portal people are shown, and is never deleted.";
  }
  return null;
}

/** The reason a delete must not proceed at all, or null. Protection first. */
export function blockReason(p: PortalFacts): string | null {
  const shielded = protectedReason(p);
  if (shielded) return shielded;
  if (portalIsLive(p)) {
    return "This portal is live — its link works right now. Switch it off first (the Live switch), then delete it.";
  }
  return null;
}

export interface OwnerRow {
  id: string;
  name: string;
  aliases: string[];
  /** os_clients.mi_client_id — the one portal the client record points at. */
  miClientId: string | null;
}

/*
 * The client a portal belongs to.
 *
 * The stored link first; then the portal's name against the client's name and
 * aliases — which is how a client's SECOND portal is tied to it. Ambiguous
 * names are not guessed. Kept identical to master-lookup's resolveByIdOrName
 * (a test compares the two), because the Client Portals page shows a row's
 * client by that function and the delete must mean the same client.
 */
export function ownerOf<T extends OwnerRow>(clients: T[], portal: Pick<PortalFacts, "id" | "name">): T | null {
  const linked = clients.find((c) => c.miClientId === portal.id);
  if (linked) return linked;
  const key = nameKey(portal.name);
  if (!key) return null;
  const matches = clients.filter((c) => [c.name, ...c.aliases].some((n) => nameKey(n) === key));
  return matches.length === 1 ? matches[0] : null;
}

/*
 * What happens to the client record's stored link.
 *
 * Untouched unless it pointed at the portal being deleted. If it did, it moves
 * to another of the client's portals when there is one (the lowest id, so the
 * answer does not depend on row order) and is cleared otherwise — a stored id
 * for a row that no longer exists is exactly the stale link Consistency exists
 * to catch.
 */
export function nextLink(
  owner: Pick<OwnerRow, "miClientId"> | null,
  deletedId: string,
  otherPortalIds: string[],
): { change: boolean; to: string | null } {
  if (!owner || owner.miClientId !== deletedId) return { change: false, to: owner?.miClientId ?? null };
  const to = [...otherPortalIds].sort()[0] ?? null;
  return { change: true, to };
}

/** True when the delete leaves the client with no portal at all. */
export function leavesClientWithoutPortal(owner: OwnerRow | null, otherPortalIds: string[]): boolean {
  return owner !== null && otherPortalIds.length === 0;
}

/*
 * The reason written for Consistency (os_client_tool_exceptions).
 *
 * A client with no Master Inbox row is otherwise reported as a gap — a fault
 * somebody should look at. Here somebody did it on purpose, and the screen
 * should say that, with the date and the person, instead of raising it daily.
 */
export function exceptionReason(portalName: string, when: Date, by: string | null): string {
  const day = when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `Its portal "${portalName}" was deleted on ${day}${by ? ` by ${by}` : ""} (Client Portals → Delete). The client was kept.`;
}

/** The typed confirmation: the portal's exact name, ignoring outer spaces. */
export function confirmationMatches(typed: string, name: string): boolean {
  return typed.trim() === name.trim() && name.trim().length > 0;
}
