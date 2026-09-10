/**
 * Matching an onboarding client to a Health Dashboard client, by name.
 *
 * Pure, and separated from the fetch/write half so the rules are testable — a
 * name-matching heuristic that nobody can exercise is exactly the kind of code
 * that silently mismatches two clients.
 *
 * Ported from the orchestrator's `lib/health-status.ts`.
 */

export type HealthStatus = "active" | "paused" | "churned";

/** A client as the Health Dashboard reports it. */
export type TheirClient = { id: string; name: string; status: string };

/** Lowercase, letters and digits only — "Norvell & Co" and "norvell&co" collapse to one key. */
export function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Drop a leading "the" so "The Discover Flag Team" can meet "Discover Flag Team". */
export function stem(s: string | null | undefined): string {
  return norm(s).replace(/^the/, "");
}

/**
 * Find the dashboard's row for one of our clients.
 *
 * Three passes, in order of confidence:
 *
 *   1. their id, once we have stored it — survives a rename on either side
 *   2. the normalised name
 *   3. one name containing the other ("Howe Realty" / "Howe Realty Group"),
 *      accepted ONLY when exactly one candidate fits, so a guess can never
 *      pick the wrong client
 *
 * The 5-character floor on pass 3 stops short names matching half the roster.
 */
export function matchClient(
  ours: { client_name: string | null; health_client_id?: string | null },
  theirs: TheirClient[],
  index?: { byId: Map<string, TheirClient>; byName: Map<string, TheirClient> },
): TheirClient | null {
  const byId = index?.byId ?? new Map(theirs.map((c) => [c.id, c]));
  const byName = index?.byName ?? new Map(theirs.map((c) => [norm(c.name), c]));

  const direct =
    (ours.health_client_id && byId.get(ours.health_client_id)) || byName.get(norm(ours.client_name));
  if (direct) return direct;

  const key = stem(ours.client_name);
  if (key.length >= 5) {
    const near = theirs.filter((t) => {
      const k = stem(t.name);
      return k.length >= 5 && (k.startsWith(key) || key.startsWith(k));
    });
    if (near.length === 1) return near[0];
  }
  return null;
}

/** The id/name lookups, built once for a whole sync. */
export function indexTheirs(theirs: TheirClient[]) {
  return {
    byId: new Map(theirs.map((c) => [c.id, c])),
    byName: new Map(theirs.map((c) => [norm(c.name), c])),
  };
}
