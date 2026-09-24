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
  /*
   * The person an introduction is addressed to, and the brokerage it names.
   * Written by the Onboard and Edit dialogs, read by the composer's Introduce
   * button. Every field is optional: a client can exist without ever being
   * introduced to anyone. See migrations/0005_os_client_contacts.sql.
   */
  contact: {
    name: string | null;
    role: string | null;
    email: string | null;
    brokerage: string | null;
    /*
     * The second and third people, when this client introduces to more than
     * one. Always two entries, either of which may be entirely empty, so the
     * edit form can render three fixed slots without counting.
     * See migrations/0007_os_client_contacts_2_3.sql.
     */
    extra: Array<{ name: string | null; role: string | null; email: string | null }>;
  };
  /*
   * The §6 master-record fields that had no home anywhere.
   *
   * Measured 2026-09-24: Account Manager was set for 0 of 46 clients, Sender
   * for 1, MLS and Market for 2 each, Salesperson for 4, and Area was stored
   * in no table at all. They are recorded here because the OS is the master
   * record, and because until there was somewhere to put them the answer to
   * "who is the account manager" was nowhere. See migration 0015.
   */
  record: {
    accountManager: string | null;
    salesperson: string | null;
    sender: string | null;
    market: string | null;
    mls: string | null;
    area: string | null;
  };
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

const BASE_SELECT =
  "id, name, slug, aliases, status, source, notes, created_at, updated_at, " +
  "mi_client_id, ch_client_id, an_client_id, orch_client_id, " +
  "contact_name, contact_role, contact_email, " +
  "contact2_name, contact2_role, contact2_email, " +
  "contact3_name, contact3_role, contact3_email, brokerage";

/** The §6 master-record fields — migration 0015. */
const RECORD_COLUMNS = "account_manager, salesperson, sender_name, market, mls, area";

/*
 * WORKS BEFORE AND AFTER MIGRATION 0015.
 *
 * Asking for a column that does not exist makes PostgREST fail the WHOLE
 * query (error 42703), so shipping this code before the migration ran would
 * have taken the Clients screen down to its roster fallback — every status
 * change silently unsaveable — until somebody noticed.
 *
 * So the column list is decided once, at first use, by trying the full one
 * and dropping back if the database has not been migrated yet. The result is
 * remembered for the process: this costs one extra failed query on the first
 * read after a cold start, and only while the migration is outstanding.
 *
 * Deliberately not a config flag. A flag is a second thing to remember to
 * change, and the failure mode of forgetting is exactly the outage above.
 */
let hasRecordColumns: boolean | null = null;

function selectList(): string {
  return hasRecordColumns === false ? BASE_SELECT : `${BASE_SELECT}, ${RECORD_COLUMNS}`;
}

/** True when the failure is "that column is not there", not something real. */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42703") return true;
  return /column .* does not exist/i.test(error.message ?? "");
}

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
    contact: {
      name: (row.contact_name as string | null) ?? null,
      role: (row.contact_role as string | null) ?? null,
      email: (row.contact_email as string | null) ?? null,
      brokerage: (row.brokerage as string | null) ?? null,
      extra: [2, 3].map((n) => ({
        name: (row[`contact${n}_name`] as string | null) ?? null,
        role: (row[`contact${n}_role`] as string | null) ?? null,
        email: (row[`contact${n}_email`] as string | null) ?? null,
      })),
    },
    record: {
      accountManager: (row.account_manager as string | null) ?? null,
      salesperson: (row.salesperson as string | null) ?? null,
      sender: (row.sender_name as string | null) ?? null,
      market: (row.market as string | null) ?? null,
      mls: (row.mls as string | null) ?? null,
      area: (row.area as string | null) ?? null,
    },
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
  let { data, error } = await osTable("os_clients").select(selectList()).order("name");
  if (error && isMissingColumn(error) && hasRecordColumns !== false) {
    // Migration 0015 has not been run here. Remember, and serve the rest.
    hasRecordColumns = false;
    ({ data, error } = await osTable("os_clients").select(BASE_SELECT).order("name"));
  }
  if (error) throw new Error(`os_clients unavailable: ${error.message}`);
  if (hasRecordColumns === null) hasRecordColumns = true;
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
    .select(selectList())
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
