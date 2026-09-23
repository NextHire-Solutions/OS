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
import {
  buildCoverage,
  type CoverageInput,
  type CoverageReport,
  type CoverageTool,
  type ExceptionIndex,
} from "./coverage";

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
  unreadable: boolean;
}

const empty = (): SourceRead => ({ byName: new Map(), labels: new Map(), unreadable: true });

async function readSource(
  fn: () => Promise<{ name: unknown; status: unknown }[]>,
): Promise<SourceRead> {
  try {
    const rows = await fn();
    const byName = new Map<string, string | null>();
    const labels = new Map<string, string>();
    for (const row of rows) {
      const display = typeof row.name === "string" ? row.name.trim() : "";
      if (!display || PLACEHOLDER.test(display)) continue;
      const key = norm(display);
      if (!key) continue;
      byName.set(key, typeof row.status === "string" ? row.status : null);
      if (!labels.has(key)) labels.set(key, display);
    }
    return { byName, labels, unreadable: false };
  } catch {
    return empty();
  }
}

export async function gatherStatusReport(): Promise<StatusReport> {
  const [os, health, analytics, inbox] = await Promise.all([
    readSource(async () => {
      const { data, error } = await getMasterInboxSupabase()
        .from("os_clients")
        .select("name, status")
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { name: unknown; status: unknown }[];
    }),
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
    ["os", os],
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
  for (const [key, status] of os.byName) {
    const statuses: Partial<Record<StatusSource, string | null>> = { os: status };
    for (const [source, read] of sources) {
      if (source === "os" || read.unreadable) continue;
      if (read.byName.has(key)) statuses[source] = read.byName.get(key) ?? null;
    }
    clients.push({ name: os.labels.get(key) ?? key, statuses });
  }

  return findStatusConflicts(
    clients,
    sources.filter(([, read]) => read.unreadable).map(([source]) => source),
  );
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
  const [os, health, analytics, inbox, onboarding, exceptions] = await Promise.all([
    readSource(async () => {
      const { data, error } = await getMasterInboxSupabase()
        .from("os_clients")
        .select("id, name, status")
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as { name: unknown; status: unknown; id?: unknown }[];
    }),
    readSource(async () => {
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
    readSource(async () => {
      // The Onboarding tool names its column `client_name`, and its `status`
      // is a PIPELINE stage, not a lifecycle — only membership is read here.
      const { data, error } = await getOnboardingDb()
        .from("orch_clients")
        .select("client_name")
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => ({ name: (r as { client_name: unknown }).client_name, status: null }));
    }),
    readExceptions(),
  ]);

  // os_clients ids, needed to look an exception up. Read separately from the
  // name index because readSource deliberately keeps only name and status.
  const idByName = new Map<string, string>();
  try {
    const { data } = await getMasterInboxSupabase()
      .from("os_clients")
      .select("id, name")
      .limit(1000);
    for (const row of (data ?? []) as { id: string; name: string }[]) {
      idByName.set(norm(row.name), row.id);
    }
  } catch {
    /* the os column read below still works; exceptions simply will not match */
  }

  const unreadable: CoverageTool[] = [];
  if (health.unreadable) unreadable.push("client_health");
  if (analytics.unreadable) unreadable.push("analytics");
  if (inbox.unreadable) unreadable.push("master_inbox");
  if (onboarding.unreadable) unreadable.push("onboarding");

  const clients: CoverageInput[] = [];
  for (const [key, status] of os.byName) {
    clients.push({
      clientId: idByName.get(key) ?? key,
      name: os.labels.get(key) ?? key,
      status: (status ?? "").toLowerCase(),
      present: {
        master_inbox: inbox.byName.has(key),
        client_health: health.byName.has(key),
        analytics: analytics.byName.has(key),
        onboarding: onboarding.byName.has(key),
      },
    });
  }

  return buildCoverage(clients, exceptions, unreadable);
}
