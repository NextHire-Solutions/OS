import "server-only";

import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { getSupabase as getClientHealthSupabase } from "@/lib/tools/client-health/supabase";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { getOnboardingDb } from "@/lib/tools/onboarding/db";
import { osTable } from "@/lib/clients/os-db";
import {
  findStatusConflicts,
  type ClientStatuses,
  type StatusReport,
  type StatusSource,
} from "./status-conflicts";
import { checkLinks, type LinkReport, type LinkTool, type ToolRows } from "./link-integrity";
import { findDuplicates, type DuplicateReport } from "./duplicates";
import { findAliasDrift, type AliasDriftReport, type AliasToolRow } from "./alias-drift";
import {
  buildCoverage,
  type CoverageInput,
  type CoverageReport,
  type CoverageTool,
  type ExceptionIndex,
} from "./coverage";
import { reconcileCounts, type CountReconciliation, type ToolRow } from "./counts";
import { nonClientReason } from "@/lib/clients/roster";

/*
 * Gathers each client's status from every source that holds one, so
 * findStatusConflicts can compare them.
 *
 * READ ONLY. Every query here is a select; this module can never write.
 *
 * Each source is read independently and may fail alone. A failure is reported
 * as `unreadable`, which the classifier refuses to treat as agreement — the
 * alternative, a screen that says "all consistent" because three of four
 * queries returned nothing, is worse than no screen.
 *
 * Joined by NORMALISED NAME rather than by the id columns on os_clients.
 * Deliberately: the ids say who we think each tool's row is, and this screen
 * exists to catch the cases where that belief is wrong. Joining on the belief
 * would hide exactly the drift being looked for — and name is how portals
 * follow status in production anyway, so this checks the join that is really
 * load-bearing.
 */

const norm = (s: unknown) =>
  typeof s === "string" ? s.toLowerCase().replace(/[^a-z0-9]/g, "") : "";

/** Rows that are buckets rather than clients — same rule as the roster diff. */
const PLACEHOLDER = /^(unassigned|unknown|none|n\/?a)$/i;

interface SourceRead {
  /** normalised name -> status */
  byName: Map<string, string | null>;
  /** display name, kept so the report shows the name a person would recognise */
  labels: Map<string, string>;
  /** the tool's own row id -> display name. Empty when rows carry no id. */
  byId: Map<string, string>;
  /** normalised name -> the tool's own row id */
  idByName: Map<string, string>;
  unreadable: boolean;
}

const empty = (): SourceRead => ({
  byName: new Map(), labels: new Map(), byId: new Map(), idByName: new Map(), unreadable: true,
});

/*
 * The master list, with every spelling each client is known by.
 *
 * ALIASES ARE PART OF IDENTITY, not decoration. A tool that stores
 * "The Discover Phx Team" holds the same client as "Discover Phx Team", and
 * os_clients already records that. Matching on the name alone reported those
 * clients as MISSING FROM THE TOOL — a gap that does not exist, in the panel
 * whose whole job is telling a real gap from a false one.
 *
 * Found by hand-reconciling the five rosters: seven "missing" clients turned
 * out to be present under a spelling the master already knew.
 */
interface OsClientKeys {
  id: string;
  name: string;
  status: string;
  /** Normalised name plus every normalised alias. */
  keys: string[];
  /** The row id this client has in each tool, as os_clients records it. */
  links: Partial<Record<LinkTool, string | null>>;
}

async function readOsClients(): Promise<{ rows: OsClientKeys[]; unreadable: boolean }> {
  try {
    const { data, error } = await getMasterInboxSupabase()
      .from("os_clients")
      .select("id, name, status, aliases, mi_client_id, ch_client_id, an_client_id, orch_client_id")
      .limit(1000);
    if (error) throw new Error(error.message);
    const rows: OsClientKeys[] = [];
    for (const raw of (data ?? []) as {
      id: string; name: string; status: string; aliases: string[] | null;
      mi_client_id: string | null; ch_client_id: string | null;
      an_client_id: string | null; orch_client_id: string | null;
    }[]) {
      const name = (raw.name ?? "").trim();
      if (!name || PLACEHOLDER.test(name)) continue;
      const keys = [name, ...(raw.aliases ?? [])].map(norm).filter(Boolean);
      rows.push({
        id: raw.id,
        name,
        status: (raw.status ?? "").toLowerCase(),
        keys: [...new Set(keys)],
        links: {
          master_inbox: raw.mi_client_id,
          client_health: raw.ch_client_id,
          analytics: raw.an_client_id,
          onboarding: raw.orch_client_id,
        },
      });
    }
    return { rows, unreadable: false };
  } catch {
    return { rows: [], unreadable: true };
  }
}

/** The tool's row for this client, under any spelling the master knows. */
function findIn(read: SourceRead, client: OsClientKeys): string | null | undefined {
  for (const k of client.keys) {
    if (read.byName.has(k)) return read.byName.get(k) ?? null;
  }
  return undefined; // no row under any known spelling
}

async function readSource(
  fn: () => Promise<{ name: unknown; status: unknown; id?: unknown }[]>,
): Promise<SourceRead> {
  try {
    const rows = await fn();
    const byName = new Map<string, string | null>();
    const labels = new Map<string, string>();
    const byId = new Map<string, string>();
    const idByName = new Map<string, string>();
    for (const row of rows) {
      const display = typeof row.name === "string" ? row.name.trim() : "";
      if (!display || PLACEHOLDER.test(display)) continue;
      const key = norm(display);
      if (!key) continue;
      byName.set(key, typeof row.status === "string" ? row.status : null);
      if (!labels.has(key)) labels.set(key, display);
      const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : null;
      if (id) {
        if (!byId.has(id)) byId.set(id, display);
        if (!idByName.has(key)) idByName.set(key, id);
      }
    }
    return { byName, labels, byId, idByName, unreadable: false };
  } catch {
    return empty();
  }
}

export async function gatherStatusReport(): Promise<StatusReport> {
  const [osRows, health, analytics, inbox] = await Promise.all([
    readOsClients(),
    readSource(async () => {
      // Client Health still derives its status from two booleans for older
      // readers; `status` is the column migration 0019 added and the trigger
      // keeps in step, so it is the one to compare.
      const { data, error } = await getClientHealthSupabase()
        .from("clients")
        .select("name, status")
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { name: unknown; status: unknown }[];
    }),
    readSource(async () => {
      const { data, error } = await getAnalyticsSupabase()
        .from("clients")
        .select("name, status")
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { name: unknown; status: unknown }[];
    }),
    readSource(async () => {
      const { data, error } = await getMasterInboxSupabase()
        .from("clients")
        .select("name, status")
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { name: unknown; status: unknown }[];
    }),
  ]);

  const sources: [StatusSource, SourceRead][] = [
    ["client_health", health],
    ["analytics", analytics],
    ["master_inbox", inbox],
  ];

  /*
   * The master's list is the spine. A name only a tool has is a MEMBERSHIP
   * difference, which the roster diff on the same screen already reports — so
   * it is left out here rather than reported twice in two different shapes.
   */
  const clients: ClientStatuses[] = [];
  for (const client of osRows.rows) {
    const statuses: Partial<Record<StatusSource, string | null>> = { os: client.status };
    for (const [source, read] of sources) {
      if (read.unreadable) continue;
      // Any spelling the master knows, not just the primary name.
      const found = findIn(read, client);
      if (found !== undefined) statuses[source] = found;
    }
    clients.push({ name: client.name, statuses });
  }

  const unreadable = sources
    .filter(([, read]) => read.unreadable)
    .map(([source]) => source);
  // The master itself failing is reported too — otherwise an empty comparison
  // would look like perfect agreement.
  if (osRows.unreadable) unreadable.push("os");

  return findStatusConflicts(clients, unreadable);
}

/*
 * The standing exceptions (§17).
 *
 * Degrades to "no exceptions" when migration 0014 has not been run: the table
 * being absent must not take the whole Consistency screen down, and "nothing
 * is explained yet" is the correct reading of an empty store anyway. The gaps
 * then simply show as gaps, which is what they were before this existed.
 */
async function readExceptions(): Promise<ExceptionIndex> {
  const index: ExceptionIndex = new Map();
  try {
    const { data, error } = await osTable("os_client_tool_exceptions")
      .select("os_client_id, tool, reason")
      .limit(2000);
    if (error) return index;
    for (const row of (data ?? []) as { os_client_id: string; tool: string; reason: string }[]) {
      if (!index.has(row.os_client_id)) index.set(row.os_client_id, new Map());
      index.get(row.os_client_id)!.set(row.tool as CoverageTool, row.reason);
    }
  } catch {
    /* table not created yet — see above */
  }
  return index;
}

/*
 * Which tools hold each client, for §17.
 *
 * Presence is decided by whether the tool's roster actually contains the name,
 * NOT by whether os_clients has an id stored for it. The stored id records
 * what we believe; this screen exists to catch where the belief is wrong, and
 * a stale id pointing at a deleted row would otherwise read as "present".
 */
export async function gatherCoverageReport(): Promise<CoverageReport> {
  const [osRows, health, analytics, inbox, onboarding, exceptions] = await Promise.all([
    readOsClients(),
    readSource(async () => {
      const { data, error } = await getClientHealthSupabase()
        .from("clients")
        .select("id, name, status")
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { name: unknown; status: unknown; id?: unknown }[];
    }),
    readSource(async () => {
      const { data, error } = await getAnalyticsSupabase()
        .from("clients")
        .select("id, name, status")
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { name: unknown; status: unknown; id?: unknown }[];
    }),
    readSource(async () => {
      const { data, error } = await getMasterInboxSupabase()
        .from("clients")
        .select("id, name, status")
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { name: unknown; status: unknown; id?: unknown }[];
    }),
    readSource(async () => {
      // The Onboarding tool names its column `client_name`, and its `status`
      // is a PIPELINE stage, not a lifecycle — only membership is read here.
      const { data, error } = await getOnboardingDb()
        .from("orch_clients")
        .select("id, client_name")
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => {
        const row = r as { id: unknown; client_name: unknown };
        return { name: row.client_name, status: null, id: row.id };
      });
    }),
    readExceptions(),
  ]);

  const unreadable: CoverageTool[] = [];
  if (health.unreadable) unreadable.push("client_health");
  if (analytics.unreadable) unreadable.push("analytics");
  if (inbox.unreadable) unreadable.push("master_inbox");
  if (onboarding.unreadable) unreadable.push("onboarding");

  const clients: CoverageInput[] = [];
  for (const client of osRows.rows) {
    clients.push({
      clientId: client.id,
      name: client.name,
      status: client.status,
      present: {
        master_inbox: findIn(inbox, client) !== undefined,
        client_health: findIn(health, client) !== undefined,
        analytics: findIn(analytics, client) !== undefined,
        onboarding: findIn(onboarding, client) !== undefined,
      },
    });
  }

  return buildCoverage(clients, exceptions, unreadable);
}

/*
 * Whether the stored links still point where they should.
 *
 * Read separately from coverage on purpose. Coverage matches on NAME because
 * it exists to catch cases where our belief about a client is wrong; this
 * checks the belief itself, and using one to check the other would be
 * circular.
 */
export async function gatherLinkReport(): Promise<LinkReport> {
  const [osRows, health, analytics, inbox, onboarding] = await Promise.all([
    readOsClients(),
    readSource(async () => {
      const { data, error } = await getClientHealthSupabase()
        .from("clients").select("id, name, status").limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { name: unknown; status: unknown; id?: unknown }[];
    }),
    readSource(async () => {
      const { data, error } = await getAnalyticsSupabase()
        .from("clients").select("id, name, status").limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { name: unknown; status: unknown; id?: unknown }[];
    }),
    readSource(async () => {
      const { data, error } = await getMasterInboxSupabase()
        .from("clients").select("id, name, status").limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { name: unknown; status: unknown; id?: unknown }[];
    }),
    readSource(async () => {
      const { data, error } = await getOnboardingDb()
        .from("orch_clients").select("id, client_name").limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => {
        const row = r as { id: unknown; client_name: unknown };
        return { name: row.client_name, status: null, id: row.id };
      });
    }),
  ]);

  const asRows = (r: SourceRead): ToolRows => ({
    byId: r.byId, idByName: r.idByName, unreadable: r.unreadable,
  });

  return checkLinks(
    osRows.rows.map((c) => ({ name: c.name, keys: c.keys, links: c.links })),
    {
      master_inbox: asRows(inbox),
      client_health: asRows(health),
      analytics: asRows(analytics),
      onboarding: asRows(onboarding),
    },
  );
}


/*
 * Duplicate clients (§16 "duplicate record", §22 "Duplicate clients are
 * detectable") — the one provision on §16's list that had no implementation.
 *
 * Reads the master list ONLY. A duplicate here is a contradiction inside
 * os_clients itself — two rows for one real client, or two rows claiming one
 * tool row — so no tool needs to be reachable to answer it, and this panel
 * cannot be taken down by a slow upstream the way the others can.
 *
 * Deliberately NOT filtered by `isPlaceholder`: a placeholder name appearing
 * twice in the master list is exactly the kind of thing worth seeing here.
 */
export async function gatherDuplicateReport(): Promise<DuplicateReport> {
  const { data, error } = await getMasterInboxSupabase()
    .from("os_clients")
    .select("id, name, aliases, mi_client_id, ch_client_id, an_client_id, orch_client_id")
    .limit(1000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as {
    id: string; name: string; aliases: string[] | null;
    mi_client_id: string | null; ch_client_id: string | null;
    an_client_id: string | null; orch_client_id: string | null;
  }[];
  return findDuplicates(
    rows.map((r) => ({
      id: r.id,
      name: r.name ?? "",
      aliases: r.aliases,
      links: {
        master_inbox: r.mi_client_id,
        client_health: r.ch_client_id,
        analytics: r.an_client_id,
        onboarding: r.orch_client_id,
      },
    })),
  );
}


/*
 * Spellings a tool does not know (§16 "conflicting data", applied to identity).
 *
 * Reads the two tools that attribute campaigns by name and hold their own alias
 * column — Analytics `aliases` and Client Health `campaign_aliases`. Master
 * Inbox is not checked: it keeps its own name and aliases and the OS is
 * deliberately not its writer, which the dictionary records.
 */
export async function gatherAliasDriftReport(): Promise<AliasDriftReport> {
  const [osRows, analytics, health] = await Promise.all([
    (async () => {
      const { data, error } = await getMasterInboxSupabase()
        .from("os_clients")
        .select("name, aliases, an_client_id, ch_client_id")
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as {
        name: string; aliases: string[] | null;
        an_client_id: string | null; ch_client_id: string | null;
      }[];
    })(),
    (async () => {
      try {
        const { data, error } = await getAnalyticsSupabase()
          .from("clients").select("id, name, aliases").limit(1000);
        if (error) throw new Error(error.message);
        return new Map(
          ((data ?? []) as { id: string; name: string; aliases: string[] | null }[]).map((r) => [
            r.id, { id: r.id, name: r.name ?? "", aliases: r.aliases ?? [] } as AliasToolRow,
          ]),
        );
      } catch { return null; }
    })(),
    (async () => {
      try {
        const { data, error } = await getClientHealthSupabase()
          .from("clients").select("id, name, campaign_aliases").limit(1000);
        if (error) throw new Error(error.message);
        return new Map(
          ((data ?? []) as { id: string; name: string; campaign_aliases: string[] | null }[]).map((r) => [
            r.id, { id: r.id, name: r.name ?? "", aliases: r.campaign_aliases ?? [] } as AliasToolRow,
          ]),
        );
      } catch { return null; }
    })(),
  ]);

  return findAliasDrift(
    osRows.map((r) => ({
      name: r.name ?? "",
      aliases: r.aliases ?? [],
      links: { analytics: r.an_client_id, client_health: r.ch_client_id },
    })),
    {
      analytics: analytics ? { rows: analytics } : { rows: new Map(), unreadable: true },
      client_health: health ? { rows: health } : { rows: new Map(), unreadable: true },
    },
  );
}

/* ===========================================================================
   CLIENT COUNTS — why each tool's total is not the master total
   ---------------------------------------------------------------------------
   Deliberately does NOT reuse `readSource`. That helper drops placeholder rows
   and collapses rows that share a normalised name, which is correct when the
   question is "does this client exist here" — and fatal when the question is
   "why does this tool say 44". The rows it discards are precisely the ones a
   person needs named: Demo Portal, a test record, a second row for one client.

   So this reads raw, keeps everything, and resolves each row to a client by
   the recorded LINK first and the client's own spellings second — the same
   order the rest of this file uses.
   =========================================================================== */

async function rawRows(
  fn: () => Promise<{ id: unknown; name: unknown }[]>,
): Promise<{ rows: { id: string; name: string }[]; unreadable: boolean }> {
  try {
    const rows = (await fn())
      .map((r) => ({
        id: typeof r.id === "string" ? r.id : String(r.id ?? ""),
        name: typeof r.name === "string" ? r.name.trim() : "",
      }))
      .filter((r) => r.name);
    return { rows, unreadable: false };
  } catch {
    return { rows: [], unreadable: true };
  }
}

export interface CountReport {
  tools: CountReconciliation[];
  unreadable: CoverageTool[];
  masterTotal: number;
}

export async function gatherCountReport(): Promise<CountReport> {
  const [osRows, inbox, health, analytics, onboarding, exceptions] = await Promise.all([
    readOsClients(),
    rawRows(async () => {
      const { data, error } = await getMasterInboxSupabase().from("clients").select("id, name").limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: unknown; name: unknown }[];
    }),
    rawRows(async () => {
      const { data, error } = await getClientHealthSupabase().from("clients").select("id, name").limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: unknown; name: unknown }[];
    }),
    rawRows(async () => {
      const { data, error } = await getAnalyticsSupabase().from("clients").select("id, name").limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: unknown; name: unknown }[];
    }),
    rawRows(async () => {
      const { data, error } = await getOnboardingDb().from("orch_clients").select("id, client_name").limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => {
        const row = r as { id: unknown; client_name: unknown };
        return { id: row.id, name: row.client_name };
      });
    }),
    readExceptions(),
  ]);

  /** normalised spelling -> master client id, covering the name and every alias. */
  const byKey = new Map<string, string>();
  for (const c of osRows.rows) for (const k of c.keys) if (!byKey.has(k)) byKey.set(k, c.id);

  // Only these four carry a recorded link column; `CoverageTool` also names
  // `database`, which does not. `LinkTool` already says exactly this, so it is
  // reused rather than respelled here.
  const linkIndex = (tool: LinkTool): Map<string, string> => {
    const m = new Map<string, string>();
    for (const c of osRows.rows) {
      const id = c.links[tool];
      if (id) m.set(String(id), c.id);
    }
    return m;
  };

  const toRows = (tool: LinkTool, read: { rows: { id: string; name: string }[] }): ToolRow[] => {
    const links = linkIndex(tool);
    return read.rows.map((r) => ({
      name: r.name,
      clientId: links.get(r.id) ?? byKey.get(norm(r.name)) ?? null,
    }));
  };

  const unreadable: CoverageTool[] = [];
  if (inbox.unreadable) unreadable.push("master_inbox");
  if (health.unreadable) unreadable.push("client_health");
  if (analytics.unreadable) unreadable.push("analytics");
  if (onboarding.unreadable) unreadable.push("onboarding");

  const rowsByTool: Partial<Record<CoverageTool, ToolRow[]>> = {};
  if (!inbox.unreadable) rowsByTool.master_inbox = toRows("master_inbox", inbox);
  if (!health.unreadable) rowsByTool.client_health = toRows("client_health", health);
  if (!analytics.unreadable) rowsByTool.analytics = toRows("analytics", analytics);
  if (!onboarding.unreadable) rowsByTool.onboarding = toRows("onboarding", onboarding);

  /*
   * A reason for an absence, from the same two places the coverage screen uses:
   * a person's written exception first, then the standing rule that a client
   * who has left is not expected in a delivery tool.
   */
  const master = osRows.rows.map((c) => ({ id: c.id, name: c.name, status: c.status }));
  const statusOf = new Map(master.map((c) => [c.id, c.status]));
  const absenceReason = (clientId: string, tool: CoverageTool): string | null => {
    const written = exceptions.get(clientId)?.get(tool);
    if (written) return written;
    const status = statusOf.get(clientId) ?? "";
    if (status === "churned") return "Churned — no longer carried by this tool.";
    if (status === "paused") return "Paused — kept out of this tool while stopped.";
    if (status === "onboarding") return "Still onboarding — not provisioned here yet.";
    return null;
  };

  return {
    tools: reconcileCounts(master, rowsByTool, absenceReason, nonClientReason),
    unreadable,
    masterTotal: master.length,
  };
}
