import "server-only";

import { getSupabase } from "./supabase";

/*
 * Client Health's three published reads, answered from its database directly.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ARE
 *
 * The live tool publishes three read-only endpoints for other systems:
 *
 *   GET /api/clients          the raw roster — every column of every client
 *   GET /api/clients/status   id + name + active | paused | churned, with counts
 *   GET /api/metrics/weekly   weekly_metrics with client names attached
 *
 * Six modules in this workspace read them over HTTP with
 * CLIENT_HEALTH_READ_TOKEN. Client Health is being switched off, and every one
 * of those reads would start failing the day it stops answering — the Clients
 * roster, Performance, both reconcile readers, the Onboarding health panel and
 * the status-board connector, all at once.
 *
 * So the queries moved here, against the same tables, returning the SAME
 * SHAPES the routes returned. The six callers now call these functions; the
 * workspace's own routes under /api/tools/client-health serve them to outside
 * consumers under the same token. Nothing downstream had to change.
 *
 * ---------------------------------------------------------------------------
 * STATUS SEMANTICS
 *
 * Three-way, mirroring the dashboard's own filter views, copied from the
 * tool's status route:
 *
 *   churned = hidden=true
 *   paused  = client_paused=true AND !hidden
 *   active  = !hidden AND !client_paused
 *
 * hidden wins if both flags are set, matching how the dashboard prioritises
 * the Hidden filter.
 */

export type ClientStatus = "active" | "paused" | "churned";

/** The tool's own rule for a client's status. */
export function statusOf(row: { hidden?: unknown; client_paused?: unknown }): ClientStatus {
  if (row.hidden) return "churned";
  if (row.client_paused) return "paused";
  return "active";
}

/** GET /api/clients — `{ clients }`. Every column, ordered by name. */
export async function listClientRows(): Promise<Record<string, unknown>[]> {
  const { data, error } = await getSupabase().from("clients").select("*").order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as Record<string, unknown>[];
}

export interface ClientStatusListing {
  total: number;
  counts: Record<ClientStatus, number>;
  clients: { id: string; name: string; status: ClientStatus }[];
}

/** GET /api/clients/status — a full roster snapshot, id + name + status. */
export async function clientStatuses(): Promise<ClientStatusListing> {
  const { data, error } = await getSupabase()
    .from("clients")
    .select("id, name, hidden, client_paused")
    .order("name");
  if (error) throw new Error(error.message);

  const clients = ((data ?? []) as { id: string; name: string; hidden: boolean; client_paused: boolean }[])
    .map((c) => ({ id: c.id, name: c.name, status: statusOf(c) }));

  const counts: Record<ClientStatus, number> = { active: 0, paused: 0, churned: 0 };
  for (const c of clients) counts[c.status]++;

  return { total: clients.length, counts, clients };
}

/*
 * GET /api/metrics/weekly.
 *
 * Copied from the tool's route (commit e373ff4). The ceilings are its:
 * DEFAULT_WEEKS one quarter, MAX_WEEKS the 26 the table holds per client, and
 * the row cap only applies when the caller gave no explicit range — otherwise
 * a narrow range would be silently truncated, which is the kind of quiet
 * wrongness the endpoint exists to eliminate.
 */

/** Monday-start ISO week key, matching how the dashboard buckets. */
const WEEK_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WEEKS = 13;
const MAX_WEEKS = 26;

export interface WeeklyMetricsQuery {
  from?: string | null;
  to?: string | null;
  weeks?: string | null;
}

export interface WeeklyMetricRow {
  client_id: string;
  client_name: string | null;
  plan: string | null;
  weekly_target: number | null;
  status: ClientStatus | null;
  week_key: string;
  emails_sent: number | null;
  intros: number | null;
  intros_corofy: number | null;
  interested_corofy: number | null;
  last_intro_at: string | null;
}

export interface WeeklyMetricsListing {
  ok: true;
  /** Stated rather than assumed: every consumer must bucket by the same boundary. */
  week_starts_on: "monday";
  definitions: Record<string, string>;
  range: { from: string | null; to: string | null };
  week_count: number;
  count: number;
  metrics: WeeklyMetricRow[];
}

export type WeeklyMetricsResult =
  | { ok: true; value: WeeklyMetricsListing }
  | { ok: false; status: number; error: string };

export async function weeklyMetrics(q: WeeklyMetricsQuery = {}): Promise<WeeklyMetricsResult> {
  const from = q.from ?? null;
  const to = q.to ?? null;

  if (from && !WEEK_KEY.test(from)) {
    return { ok: false, status: 400, error: "from must be YYYY-MM-DD (a Monday week_key)" };
  }
  if (to && !WEEK_KEY.test(to)) {
    return { ok: false, status: 400, error: "to must be YYYY-MM-DD (a Monday week_key)" };
  }

  let weeks = DEFAULT_WEEKS;
  if (q.weeks != null) {
    const parsed = Number(q.weeks);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, status: 400, error: "weeks must be a positive integer" };
    }
    weeks = Math.min(parsed, MAX_WEEKS);
  }

  const sb = getSupabase();

  let query = sb
    .from("weekly_metrics")
    .select("client_id, week_key, emails_sent, intros, intros_corofy, interested_corofy, last_intro_at")
    .order("week_key", { ascending: false });
  if (from) query = query.gte("week_key", from);
  if (to) query = query.lte("week_key", to);

  const { data: rows, error } = await (from || to ? query : query.limit(weeks * 200));
  if (error) return { ok: false, status: 500, error: error.message };

  const { data: clients, error: clientsError } = await sb
    .from("clients")
    .select("id, name, plan, weekly_target, hidden, client_paused");
  if (clientsError) return { ok: false, status: 500, error: clientsError.message };

  type ClientBit = { id: string; name: string; plan: string; weekly_target: number; hidden: boolean; client_paused: boolean };
  const byId = new Map(((clients ?? []) as ClientBit[]).map((c) => [c.id, c]));

  // Names are included alongside ids because every other tool in the stack
  // joins clients by NAME, not by id.
  const metrics: WeeklyMetricRow[] = ((rows ?? []) as Record<string, unknown>[]).map((r) => {
    const client = byId.get(String(r.client_id));
    return {
      client_id: String(r.client_id),
      client_name: client?.name ?? null,
      plan: client?.plan ?? null,
      weekly_target: client?.weekly_target ?? null,
      status: client ? statusOf(client) : null,
      week_key: String(r.week_key),
      emails_sent: (r.emails_sent as number | null) ?? null,
      intros: (r.intros as number | null) ?? null,
      intros_corofy: (r.intros_corofy as number | null) ?? null,
      interested_corofy: (r.interested_corofy as number | null) ?? null,
      last_intro_at: (r.last_intro_at as string | null) ?? null,
    };
  });

  const weekKeys = [...new Set(metrics.map((m) => m.week_key))].sort();

  return {
    ok: true,
    value: {
      ok: true,
      week_starts_on: "monday",
      definitions: {
        emails_sent: "Emails sent that week, summed from Instantly and EmailBison.",
        intros: "Introductions recorded that week by this app.",
        intros_corofy: "Introductions imported from Master Inbox for that week.",
        interested_corofy: "Threads labelled Interested in Master Inbox for that week.",
      },
      range: { from: weekKeys[0] ?? null, to: weekKeys[weekKeys.length - 1] ?? null },
      week_count: weekKeys.length,
      count: metrics.length,
      metrics,
    },
  };
}

/*
 * ---------------------------------------------------------------------------
 * THE READ TOKEN
 *
 * The tool authenticates machine readers with `x-admin-token` against
 * READ_ONLY_TOKEN, failing CLOSED when the variable is unset: "unset" meaning
 * "allow" would let one missing variable open the client list to the internet.
 * The workspace's name for the same secret is CLIENT_HEALTH_READ_TOKEN.
 *
 * Constant-time compare, as the tool does it — `===` leaks how much of a guess
 * was correct.
 */

export type ReadAuth = "ok" | "unconfigured" | "denied";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function checkReadToken(supplied: string | null): ReadAuth {
  const expected = process.env.CLIENT_HEALTH_READ_TOKEN?.trim();
  if (!expected) return "unconfigured";
  return supplied && safeEqual(supplied, expected) ? "ok" : "denied";
}
