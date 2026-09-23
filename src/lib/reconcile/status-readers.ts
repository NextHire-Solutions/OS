import "server-only";

import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { getSupabase as getClientHealthSupabase } from "@/lib/tools/client-health/supabase";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import {
  findStatusConflicts,
  type ClientStatuses,
  type StatusReport,
  type StatusSource,
} from "./status-conflicts";

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
