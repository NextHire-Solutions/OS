import "server-only";

import { osTable } from "./os-db";
import { CLIENT_STATUSES, type ClientStatus } from "./client-status";
import { resolveLinks, toSlug, type ToolKey } from "./links";
import { ROSTER } from "./roster";

/*
 * The canonical client list, as stored.
 *
 * `roster.ts` is still the seed and still the thing a human edits in a pull
 * request, but once a client is in `os_clients` the STORED row wins. That is
 * the whole point of the table: adding a client stops needing a deploy, and a
 * status change is a click rather than a commit.
 *
 * Nothing here writes to any tool. The only tables touched are the OS's own
 * two, through the guarded client in os-db.ts.
 */

export { CLIENT_STATUSES, isClientStatus, type ClientStatus } from "./client-status";

export interface OsClient {
  id: string;
  name: string;
  slug: string;
  aliases: string[];
  status: ClientStatus;
  links: Record<ToolKey, string | null>;
  source: "roster" | "os" | "onboarding";
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** DB column ↔ tool key. One place, so the mapping cannot drift. */
const LINK_COLUMN: Record<ToolKey, string> = {
  masterInbox: "mi_client_id",
  clientHealth: "ch_client_id",
  analytics: "an_client_id",
  onboarding: "orch_client_id",
};

const SELECT =
  "id, name, slug, aliases, status, source, notes, created_at, updated_at, " +
  "mi_client_id, ch_client_id, an_client_id, orch_client_id";

type Row = Record<string, unknown>;

function toClient(row: Row): OsClient {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    slug: String(row.slug ?? ""),
    aliases: Array.isArray(row.aliases) ? (row.aliases as string[]) : [],
    status: (row.status as ClientStatus) ?? "active",
    links: {
      masterInbox: (row.mi_client_id as string | null) ?? null,
      clientHealth: (row.ch_client_id as string | null) ?? null,
      analytics: (row.an_client_id as string | null) ?? null,
      onboarding: (row.orch_client_id as string | null) ?? null,
    },
    source: (row.source as OsClient["source"]) ?? "roster",
    notes: (row.notes as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/**
 * Every client the business has.
 *
 * An empty table is a legitimate answer only before seeding, so the caller is
 * told which it got rather than having to guess from a zero — reporting "0
 * clients" as though it were a fact is the failure mode this codebase has hit
 * more than once.
 */
export async function listOsClients(): Promise<OsClient[]> {
  const { data, error } = await osTable("os_clients").select(SELECT).order("name");
  if (error) throw new Error(`os_clients unavailable: ${error.message}`);
  return (data ?? []).map((r) => toClient(r as unknown as Row));
}

export async function isSeeded(): Promise<boolean> {
  const { count, error } = await osTable("os_clients")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(`os_clients unavailable: ${error.message}`);
  return (count ?? 0) > 0;
}

/**
 * Change a client's status. The only mutation the roster screen performs.
 *
 * There is deliberately no delete, here or anywhere: a client that stops
 * trading becomes `churned` and can become `active` again. Portal tokens and
 * history have to survive, and "we removed the row" is not recoverable.
 */
export async function setClientStatus(id: string, status: ClientStatus): Promise<OsClient> {
  if (!CLIENT_STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);
  const { data, error } = await osTable("os_clients")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(SELECT)
    .single();
  if (error) throw new Error(`Could not update status: ${error.message}`);
  return toClient(data as unknown as Row);
}

export interface SeedResult {
  inserted: number;
  updated: number;
  linked: Record<ToolKey, number>;
  /** Clients whose link could not be decided, so none was stored. */
  ambiguous: { name: string; tools: ToolKey[] }[];
  dryRun: boolean;
  rows: Array<{ name: string; slug: string; links: Record<ToolKey, string | null>; action: "insert" | "update" }>;
}

/**
 * Seeds `os_clients` from the code roster and fills in the per-tool links.
 *
 * Idempotent by slug: running it twice updates rather than duplicates, and it
 * never changes `status`, which is a human's decision and must not be reset by
 * a re-seed.
 *
 * `dryRun` is the default on purpose. Every destructive-looking thing in this
 * project gets a dry run first, and this one writes 36 rows that other writes
 * will later key off.
 */
export async function seedOsClients({ dryRun = true }: { dryRun?: boolean } = {}): Promise<SeedResult> {
  const report = await resolveLinks(ROSTER);

  const { data: existingRows, error } = await osTable("os_clients").select("id, slug");
  if (error) throw new Error(`os_clients unavailable: ${error.message}`);
  const bySlug = new Map<string, string>(
    (existingRows ?? []).map((r) => {
      const row = r as unknown as Row;
      return [String(row.slug), String(row.id)] as const;
    }),
  );

  const linked: Record<ToolKey, number> = {
    masterInbox: 0, clientHealth: 0, analytics: 0, onboarding: 0,
  };
  const ambiguous: SeedResult["ambiguous"] = [];
  const rows: SeedResult["rows"] = [];

  let inserted = 0;
  let updated = 0;

  for (const client of report.clients) {
    const slug = toSlug(client.name);
    const existingId = bySlug.get(slug);
    const action = existingId ? "update" : "insert";

    for (const tool of Object.keys(linked) as ToolKey[]) {
      if (client.links[tool]) linked[tool] += 1;
    }
    if (client.ambiguous.length > 0) {
      ambiguous.push({ name: client.name, tools: client.ambiguous });
    }

    rows.push({ name: client.name, slug, links: client.links, action });

    if (dryRun) {
      if (existingId) updated += 1;
      else inserted += 1;
      continue;
    }

    /*
     * `status` and `source` are set on INSERT only. A re-seed must never move a
     * client someone marked `churned` back to `active`, and must never relabel
     * a client onboarded in the OS as having come from the roster.
     */
    const links = Object.fromEntries(
      (Object.keys(LINK_COLUMN) as ToolKey[]).map((t) => [LINK_COLUMN[t], client.links[t]]),
    );

    if (existingId) {
      const { error: e } = await osTable("os_clients")
        .update({ name: client.name, aliases: client.aliases, ...links, updated_at: new Date().toISOString() })
        .eq("id", existingId);
      if (e) throw new Error(`Could not update ${client.name}: ${e.message}`);
      updated += 1;
    } else {
      const { error: e } = await osTable("os_clients")
        .insert({ name: client.name, slug, aliases: client.aliases, status: "active", source: "roster", ...links });
      if (e) throw new Error(`Could not insert ${client.name}: ${e.message}`);
      inserted += 1;
    }
  }

  return { inserted, updated, linked, ambiguous, dryRun, rows };
}
