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

/**
 * A tool's rows, indexed by the tool's OWN id.
 *
 * `os_clients` already records which row is this client's in each tool
 * (`mi_client_id`, `ch_client_id`, `an_client_id`, `orch_client_id`), and an
 * id is the only identifier that survives a rename. Names do not: renaming
 * "Douglas Elliman LA" to "Douglas Elliman Los Angeles" silently unhooked that
 * client from two tools until the lists were reconciled by hand.
 *
 * Empty when a tool's rows carry no id — Master Inbox's intro-stats endpoint
 * returns names and counts only — and that is fine: resolution then falls back
 * to the name, exactly as it worked before.
 */
export function indexById(
  rows: Record<string, unknown>[],
  idField = "id",
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const raw = row[idField];
    const id = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    if (!id || out.has(id)) continue;
    out.set(id, row);
  }
  return out;
}

/** Every key a client should be found under: its name, then its aliases. */
export function keysForClient(client: CanonicalClient): string[] {
  return [client.name, ...(client.aliases ?? [])].map(keyOf);
}

export interface PickResult {
  row: Record<string, unknown> | undefined;
  /** How it was found. `id` is the durable one; `name` still works. */
  via: "id" | "name" | "none";
  /*
   * A stored id pointed at nothing, but the name found a row anyway.
   *
   * Not an error — the fallback worked — but worth seeing, because it is
   * precisely the case that breaks on the day names stop being the join.
   */
  staleLink: boolean;
}

/**
 * The tool row belonging to a client.
 *
 * ID FIRST, NAME SECOND, and the order is the whole point. The id is what
 * os_clients recorded deliberately; the name is a guess that happens to work
 * most of the time. Trying the id first means a rename stops breaking the
 * join. Keeping the name fallback means nothing that resolves today can stop
 * resolving — this is additive, never a replacement.
 */
export function pickWithSource(
  client: CanonicalClient,
  index: Map<string, Record<string, unknown>>,
  byId?: Map<string, Record<string, unknown>>,
  linkedId?: string | null,
): PickResult {
  if (linkedId && byId) {
    const hit = byId.get(linkedId);
    if (hit) return { row: hit, via: "id", staleLink: false };
  }
  for (const k of keysForClient(client)) {
    const hit = index.get(k);
    if (hit) return { row: hit, via: "name", staleLink: Boolean(linkedId && byId) };
  }
  return { row: undefined, via: "none", staleLink: false };
}

/** The tool row belonging to a client, or undefined if the tool has none. */
export function pickFor(
  client: CanonicalClient,
  index: Map<string, Record<string, unknown>>,
  byId?: Map<string, Record<string, unknown>>,
  linkedId?: string | null,
): Record<string, unknown> | undefined {
  return pickWithSource(client, index, byId, linkedId).row;
}
