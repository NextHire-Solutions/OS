// Relative with the extension, not the `@/` alias: unit-tested with
// `node --test`, which resolves neither.
import { keyOf, type CanonicalClient } from "./roster.ts";

/*
 * Matching a workspace client to a tool's row for it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE
 *
 * It lived inside `overview.ts`, which reads three live APIs, so the matching
 * rule could not be tested without the network — and it was wrong for months
 * without anyone noticing.
 *
 * The rule used to be "look the tool's row up in the ROSTER array compiled into
 * the build, and key the index by whatever canonical client comes back." A row
 * whose name is not in that array resolves to null and is silently dropped.
 * The Clients page lists clients from `os_clients`, which is live, so any
 * client added after the last deploy vanished from every tool column — showing
 * "missing" three times over for a client that was, in fact, correctly set up
 * in all three tools.
 *
 * That is the exact failure mode of onboarding a client through the OS: the
 * three legs succeed, and the page then reports the result as broken.
 */

/** A tool's rows, indexed by the normalised form of each row's client name. */
export function indexByName(
  rows: Record<string, unknown>[],
  nameField: string,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const raw = row[nameField];
    const name = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    if (!name) continue;
    // First row wins. A tool holding two rows for one client is itself a
    // finding, and surfaces on the Consistency screen rather than being
    // silently merged here.
    const k = keyOf(name);
    if (!out.has(k)) out.set(k, row);
  }
  return out;
}

/** Every key a client should be found under: its name, then its aliases. */
export function keysForClient(client: CanonicalClient): string[] {
  return [client.name, ...(client.aliases ?? [])].map(keyOf);
}

/** The tool row belonging to a client, or undefined if the tool has none. */
export function pickFor(
  client: CanonicalClient,
  index: Map<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  for (const k of keysForClient(client)) {
    const hit = index.get(k);
    if (hit) return hit;
  }
  return undefined;
}
