// Sync worker: pulls fresh data from Instantly + EmailBison + MasterInbox,
// upserts into Supabase. Backfills the last N weeks of weekly_metrics so the
// dashboard can navigate historical weeks without hitting the third-party APIs
// again.
//
// ---------------------------------------------------------------------------
// PORTED from the tool's scripts/sync.ts (eb7d572), which ran as the Railway
// `sync-worker` service (`npx tsx scripts/sync.ts`, cron `*/15 * * * *`) and
// behind the tool's POST /api/sync/run. The logic is the tool's, step for step:
// the same short-circuits, the same columns, the same warnings, the same
// read-modify-write in runBison so the two email sources never clobber each
// other. Three changes, none to what is written:
//
//   · the per-run "today's emails" maps are a RunContext handed down the call
//     chain rather than module-level `let`s — module state was fine for a
//     one-shot cron process, and is a race in a server that also runs the
//     button;
//   · the Supabase client and the clock are injectable, so the row mapping and
//     the short-circuit rules are testable without a database;
//   · the per-source row builders and the Corofy bucketing are named functions
//     rather than inline closures, for the same reason. Their bodies are the
//     tool's.
//
// Environment: CLIENT_HEALTH_* throughout, read through the workspace's
// `optionalEnv` — see supabase.ts for why the names are namespaced.

import type { SupabaseClient } from "@supabase/supabase-js";

import { optionalEnv } from "@/lib/env";

import { getSupabase } from "../supabase";
import {
  campaignSize,
  dailyAnalytics,
  listAnalytics,
  listCampaigns,
  mapStatus,
  progressPct,
  type InstantlyAnalyticsItem,
  type InstantlyCampaignSummary,
} from "./instantly";
import {
  bisonCampaignSize,
  bisonDailyStats,
  bisonProgressPct,
  listBisonCampaigns,
  mapBisonStatus,
  type BisonCampaignSummary,
} from "./bison";
import {
  addDays,
  getMondayOf,
  lastBillingDate,
  monthlyCycleStart,
  normalizeName,
  todayInET,
  weekKey,
} from "../derive";
import { listCorofyIntros, type CorofyIntro } from "./corofy";
import { listCorofyPortals } from "./portals";
import { autoMatchCampaignIds } from "../matchCampaigns";
import { HISTORICAL_WEEKS } from "../types";

// Corofy client-name aliases — intros/interested/hired rows tagged with any
// of the alias names get counted under the primary client name here. Use
// only when Corofy has legitimately-separate portals that BrokerStaffer
// treats as one client (no equivalent client row on our side).
const CLIENT_NAME_ALIASES: Record<string, string[]> = {
  'Properties & Estates': ['Properties & Estates Florida'],
};

// Build a lookup: normalized alias name → normalized primary name.
const _ALIAS_OVERRIDE = new Map<string, string>();
for (const [primary, aliases] of Object.entries(CLIENT_NAME_ALIASES)) {
  const primaryNorm = normalizeName(primary);
  for (const a of aliases) _ALIAS_OVERRIDE.set(normalizeName(a), primaryNorm);
}

// Wrap normalizeName so alias-name intros collapse to the primary name.
// Everywhere the sync worker keys intros by name should route through this.
export function normalizeClientName(name: string): string {
  const n = normalizeName(name);
  return _ALIAS_OVERRIDE.get(n) ?? n;
}

export interface SyncResult {
  instantly: { ok: boolean; error?: string; campaigns?: number; weeksBackfilled?: number };
  bison: { ok: boolean; error?: string; campaigns?: number; weeksBackfilled?: number; skipped?: boolean };
  corofy: {
    ok: boolean;
    error?: string;
    intros?: number;
    interested?: number;     // count of "Interested"-labeled rows fetched
    hired?: number;          // count of "Hired"-labeled rows fetched (0 until Corofy exposes the label)
    hiredSkipped?: boolean;  // true if the Hired label call 404'd (label doesn't exist yet)
    skipped?: boolean;
    unmatched?: string[];
    portalsMatched?: number; // # clients flipped to portal_active=true
  };
}

/**
 * Per-run state for today's email rollup. runInstantly + runBison populate
 * these per-campaign maps during their daily-data loops; runSync reads them
 * after both finish and writes clients.emails_today.
 */
export interface RunContext {
  db: SupabaseClient;
  now: Date;
  todayET: string;
  todayInstantlyByCampaign: Map<string, number>;
  todayBisonByCampaign: Map<string, number>;
}

export interface RunSyncOptions {
  /** Defaults to Client Health's own Supabase project. Injectable for tests. */
  db?: SupabaseClient;
  now?: Date;
}

export function newRunContext(opts: RunSyncOptions = {}): RunContext {
  return {
    db: opts.db ?? getSupabase(),
    now: opts.now ?? new Date(),
    todayET: todayInET(),
    todayInstantlyByCampaign: new Map(),
    todayBisonByCampaign: new Map(),
  };
}

export async function runSync(opts: RunSyncOptions = {}): Promise<SyncResult> {
  const ctx = newRunContext(opts);
  const result: SyncResult = {
    instantly: { ok: false },
    bison: { ok: false },
    corofy: { ok: false },
  };
  result.instantly = await runInstantly(ctx);
  result.bison = await runBison(ctx);
  result.corofy = await runCorofy(ctx);
  await updateClientsTodayEmails(ctx).catch((e) =>
    console.warn(`[today-emails] writeback failed: ${(e as Error).message}`),
  );
  return result;
}

async function updateClientsTodayEmails(ctx: RunContext): Promise<void> {
  const sb = ctx.db;
  const { data: clients } = await sb
    .from('clients')
    .select('id, instantly_campaign_ids, bison_campaign_ids');
  if (!clients) return;
  let written = 0;
  for (const c of clients as { id: string; instantly_campaign_ids: string[]; bison_campaign_ids: string[] }[]) {
    let total = 0;
    for (const cid of c.instantly_campaign_ids ?? []) total += ctx.todayInstantlyByCampaign.get(cid) ?? 0;
    for (const cid of c.bison_campaign_ids ?? []) total += ctx.todayBisonByCampaign.get(cid) ?? 0;
    const { error } = await sb
      .from('clients')
      .update({ emails_today: total, emails_today_date: ctx.todayET })
      .eq('id', c.id);
    if (!error) written++;
  }
  console.warn(`[today-emails] ${ctx.todayET}: wrote ${written}/${clients.length} clients`);
}

// All ISO Mondays for the visible window, oldest → newest.
export function backfillWindow(today: Date = new Date()): { mondayKeys: string[]; rangeStart: string; rangeEnd: string } {
  const thisMonday = getMondayOf(today);
  const earliest = addDays(thisMonday, -7 * (HISTORICAL_WEEKS - 1));
  const mondayKeys: string[] = [];
  for (let i = 0; i < HISTORICAL_WEEKS; i++) {
    mondayKeys.push(weekKey(addDays(earliest, 7 * i)));
  }
  const rangeStart = weekKey(earliest);
  // End of current week: next Monday minus 1 day = Sunday.
  const rangeEnd = addDays(thisMonday, 6).toISOString().split('T')[0];
  return { mondayKeys, rangeStart, rangeEnd };
}

// Decide the new status_changed_at value for a campaign. Returns undefined to
// mean "leave the existing DB value alone" (no field in the upsert payload).
//
//   1. Real transition observed (prev status differs from new) → now()
//   2. Status is paused/finished AND no stamp on file yet → seed from the
//      vendor's updated_at. Covers both "first time we see this campaign" AND
//      "existing row from before the migration added status_changed_at".
//   3. Otherwise → undefined (preserve current value).
export function deriveStatusChangedAt(
  newStatus: 'running' | 'paused' | 'finished' | null,
  prevStatus: string | null | undefined,
  prevStatusChangedAt: string | null | undefined,
  apiUpdatedAt: string | null | undefined,
  now: Date = new Date(),
): string | null | undefined {
  const prev = prevStatus ?? null;
  const next = newStatus ?? null;
  const isTransition = prevStatus !== undefined && prev !== next;
  if (isTransition) return now.toISOString();
  if ((next === 'paused' || next === 'finished') && !prevStatusChangedAt) {
    return apiUpdatedAt ?? now.toISOString();
  }
  return undefined;
}

/** The previous cache row, when there is one, for status-transition detection. */
export interface PreviousStatus {
  status: string | null;
  status_changed_at: string | null;
}

export interface InstantlyCampaignRow {
  id: string;
  name: string;
  status: ReturnType<typeof mapStatus>;
  emails_sent_total: number;
  campaign_size: number;
  progress_pct: number;
  reply_count: number;
  status_changed_at?: string | null;
}

/** One `instantly_campaigns` row, exactly as the tool builds it. */
export function instantlyCampaignRow(
  c: InstantlyCampaignSummary,
  a: InstantlyAnalyticsItem | undefined,
  prev: PreviousStatus | undefined,
  now: Date = new Date(),
): InstantlyCampaignRow {
  const newStatus = mapStatus(c.status ?? a?.campaign_status);
  const stamp = deriveStatusChangedAt(
    newStatus,
    prev ? prev.status : undefined,
    prev?.status_changed_at,
    c.timestamp_updated,
    now,
  );
  const base: InstantlyCampaignRow = {
    id: c.id,
    name: c.name,
    status: newStatus,
    emails_sent_total: a?.emails_sent_count ?? 0,
    campaign_size: a ? campaignSize(a) : 0,
    progress_pct: a ? Number(progressPct(a).toFixed(2)) : 0,
    // Prefer unique replies (one per lead); fall back to total reply_count
    // if the analytics row doesn't carry unique. interested_count is
    // written below by the Corofy step, not here.
    reply_count: a?.reply_count_unique ?? a?.reply_count ?? 0,
  };
  // Only include status_changed_at in the upsert payload when we actually
  // want to write it (undefined means "leave existing value alone").
  if (stamp !== undefined) base.status_changed_at = stamp;
  return base;
}

export interface BisonCampaignRow {
  id: string;
  int_id: number;
  name: string;
  status: ReturnType<typeof mapBisonStatus>;
  emails_sent_total: number;
  campaign_size: number;
  progress_pct: number;
  reply_count: number;
  status_changed_at?: string | null;
}

/** One `bison_campaigns` row, exactly as the tool builds it. */
export function bisonCampaignRow(
  c: BisonCampaignSummary,
  prev: PreviousStatus | undefined,
  now: Date = new Date(),
): BisonCampaignRow {
  const newStatus = mapBisonStatus(c.status);
  const stamp = deriveStatusChangedAt(
    newStatus,
    prev ? prev.status : undefined,
    prev?.status_changed_at,
    c.updated_at,
    now,
  );
  const base: BisonCampaignRow = {
    id: c.uuid,
    int_id: c.id, // Bison's integer id — needed for per-campaign endpoints
    name: c.name,
    status: newStatus,
    emails_sent_total: c.emails_sent ?? 0,
    campaign_size: bisonCampaignSize(c),
    progress_pct: Number(bisonProgressPct(c).toFixed(2)),
    // Prefer unique_replies; fall back to total replied. interested_count
    // is written below by the Corofy step.
    reply_count: c.unique_replies ?? c.replied ?? 0,
  };
  if (stamp !== undefined) base.status_changed_at = stamp;
  return base;
}

async function loadPreviousStatuses(sb: SupabaseClient, table: 'instantly_campaigns' | 'bison_campaigns') {
  // Load existing rows to detect status transitions.
  const { data: existingRows } = await sb.from(table).select('id, status, status_changed_at');
  return new Map<string, PreviousStatus>(
    ((existingRows ?? []) as { id: string; status: string | null; status_changed_at: string | null }[]).map(
      (r) => [r.id, { status: r.status, status_changed_at: r.status_changed_at }]
    )
  );
}

/**
 * AUTO-RELINK every client to its matching campaigns on every sync — the
 * same whole-name match for both sources, writing only when the set changed.
 */
async function relinkClients(
  sb: SupabaseClient,
  column: 'instantly_campaign_ids' | 'bison_campaign_ids',
  namedCampaigns: { id: string; name: string }[],
): Promise<void> {
  const { data: clientsForRelink } = await sb.from('clients').select(`id, name, ${column}`);
  if (!clientsForRelink) return;
  for (const c of clientsForRelink as unknown as ({ id: string; name: string } & Record<typeof column, string[]>)[]) {
    const expected = autoMatchCampaignIds(c.name, namedCampaigns).sort();
    const current = [...(c[column] ?? [])].sort();
    const same = expected.length === current.length && expected.every((id, i) => id === current[i]);
    if (!same) {
      await sb.from('clients').update({ [column]: expected }).eq('id', c.id);
    }
  }
}

async function finishRun(sb: SupabaseClient, runId: string | undefined, error?: string): Promise<void> {
  await sb
    .from('sync_runs')
    .update(
      error === undefined
        ? { ok: true, finished_at: new Date().toISOString() }
        : { ok: false, error, finished_at: new Date().toISOString() },
    )
    .eq('id', runId);
}

export async function runInstantly(ctx: RunContext): Promise<SyncResult['instantly']> {
  const sb = ctx.db;
  const { data: run } = await sb
    .from('sync_runs')
    .insert({ source: 'instantly' })
    .select('id')
    .single();

  try {
    const [campaigns, analytics] = await Promise.all([listCampaigns(), listAnalytics()]);
    const analyticsById = new Map(analytics.map((a) => [a.campaign_id, a]));

    const existingById = await loadPreviousStatuses(sb, 'instantly_campaigns');

    const campaignRows = campaigns.map((c) =>
      instantlyCampaignRow(c, analyticsById.get(c.id), existingById.get(c.id), ctx.now),
    );
    if (campaignRows.length > 0) {
      const { error } = await sb.from('instantly_campaigns').upsert(campaignRows);
      if (error) throw new Error(error.message);
    }

    // AUTO-RELINK every client to its matching campaigns on every sync.
    await relinkClients(sb, 'instantly_campaign_ids', campaigns.map((c) => ({ id: c.id, name: c.name })));

    const { mondayKeys, rangeStart, rangeEnd } = backfillWindow(ctx.now);

    const { data: clients } = await sb
      .from('clients')
      .select('id, instantly_campaign_ids');
    if (!clients) {
      await finishRun(sb, run?.id);
      return { ok: true, campaigns: campaignRows.length, weeksBackfilled: 0 };
    }

    // Collect all unique campaign ids referenced by clients.
    const linkedIds = new Set<string>();
    for (const c of clients as { instantly_campaign_ids: string[] }[]) {
      (c.instantly_campaign_ids ?? []).forEach((id) => linkedIds.add(id));
    }

    // campaignId -> weekKey -> { sent, replies }
    const campaignWeekly = new Map<string, Map<string, { sent: number; replies: number }>>();
    for (const cid of linkedIds) {
      try {
        const days = await dailyAnalytics(cid, rangeStart, rangeEnd);
        const buckets = new Map<string, { sent: number; replies: number }>();
        for (const d of days) {
          if (!d.date) continue;
          const wk = weekKey(d.date);
          const cur = buckets.get(wk) ?? { sent: 0, replies: 0 };
          cur.sent += d.sent ?? 0;
          cur.replies += d.replies ?? 0;
          buckets.set(wk, cur);
          // Capture today's-only count for the per-client "Today" rollup.
          if (d.date === ctx.todayET) {
            ctx.todayInstantlyByCampaign.set(
              cid,
              (ctx.todayInstantlyByCampaign.get(cid) ?? 0) + (d.sent ?? 0),
            );
          }
        }
        campaignWeekly.set(cid, buckets);
      } catch (err) {
        console.warn(`daily-analytics failed for ${cid}:`, (err as Error).message);
        campaignWeekly.set(cid, new Map());
      }
    }

    // For each client × each week, sum across linked Instantly campaigns and upsert.
    // NOTE: emails_sent + replies here are the Instantly subtotal. runBison()
    // ADDs to these rows in a second upsert (read-modify-write) so the final
    // value is the combined cross-source total.
    const upserts: { client_id: string; week_key: string; emails_sent: number; replies: number }[] = [];
    for (const c of clients as { id: string; instantly_campaign_ids: string[] }[]) {
      for (const wk of mondayKeys) {
        let sent = 0;
        let replies = 0;
        for (const cid of c.instantly_campaign_ids ?? []) {
          const b = campaignWeekly.get(cid)?.get(wk);
          if (b) { sent += b.sent; replies += b.replies; }
        }
        upserts.push({ client_id: c.id, week_key: wk, emails_sent: sent, replies });
      }
    }

    if (upserts.length > 0) {
      const { error } = await sb
        .from('weekly_metrics')
        .upsert(upserts, { onConflict: 'client_id,week_key', ignoreDuplicates: false });
      if (error) throw new Error(error.message);
    }

    await finishRun(sb, run?.id);
    return { ok: true, campaigns: campaignRows.length, weeksBackfilled: mondayKeys.length };
  } catch (err) {
    const message = (err as Error).message;
    await finishRun(sb, run?.id, message);
    return { ok: false, error: message };
  }
}

/** The tool's rule: no Bison key, no Bison step. Checked before the database is touched. */
export function bisonConfigured(env: (name: string) => string | undefined = optionalEnv): boolean {
  return Boolean(env('CLIENT_HEALTH_BISON_API_KEY'));
}

export async function runBison(ctx: RunContext): Promise<SyncResult['bison']> {
  if (!bisonConfigured()) return { ok: true, skipped: true };

  const sb = ctx.db;
  const { data: run } = await sb
    .from('sync_runs')
    .insert({ source: 'bison' })
    .select('id')
    .single();

  try {
    const campaigns = await listBisonCampaigns();

    const existingById = await loadPreviousStatuses(sb, 'bison_campaigns');

    const campaignRows = campaigns.map((c) => bisonCampaignRow(c, existingById.get(c.uuid), ctx.now));
    if (campaignRows.length > 0) {
      const { error } = await sb.from('bison_campaigns').upsert(campaignRows);
      if (error) throw new Error(error.message);
    }

    // Auto-relink Bison campaigns to clients using the same whole-name match.
    await relinkClients(sb, 'bison_campaign_ids', campaigns.map((c) => ({ id: c.uuid, name: c.name })));

    const { mondayKeys, rangeStart, rangeEnd } = backfillWindow(ctx.now);

    const { data: clients } = await sb
      .from('clients')
      .select('id, bison_campaign_ids');
    if (!clients) {
      await finishRun(sb, run?.id);
      return { ok: true, campaigns: campaignRows.length, weeksBackfilled: 0 };
    }

    const linkedIds = new Set<string>();
    for (const c of clients as { bison_campaign_ids: string[] }[]) {
      (c.bison_campaign_ids ?? []).forEach((id) => linkedIds.add(id));
    }

    // uuid → integer id (from the list response); Bison's per-campaign
    // endpoints reject UUIDs, so we use the int id when calling them.
    const intIdByUuid = new Map<string, number>(campaigns.map((c) => [c.uuid, c.id]));

    const campaignWeekly = new Map<string, Map<string, { sent: number; replies: number }>>();
    for (const cid of linkedIds) {
      const intId = intIdByUuid.get(cid);
      if (intId === undefined) {
        console.warn(`bison int id missing for ${cid} — skipping per-day fetch`);
        continue;
      }
      try {
        const days = await bisonDailyStats(intId, rangeStart, rangeEnd);
        const buckets = new Map<string, { sent: number; replies: number }>();
        for (const d of days) {
          if (!d.date) continue;
          const wk = weekKey(d.date);
          const cur = buckets.get(wk) ?? { sent: 0, replies: 0 };
          cur.sent += d.sent ?? 0;
          cur.replies += d.replied ?? 0;
          buckets.set(wk, cur);
          if (d.date === ctx.todayET) {
            ctx.todayBisonByCampaign.set(
              cid,
              (ctx.todayBisonByCampaign.get(cid) ?? 0) + (d.sent ?? 0),
            );
          }
        }
        campaignWeekly.set(cid, buckets);
      } catch (err) {
        console.warn(`bison daily-stats failed for ${cid} (int_id=${intId}):`, (err as Error).message);
        campaignWeekly.set(cid, new Map());
      }
    }

    // Read existing weekly_metrics rows so we can ADD Bison totals on top of
    // the Instantly subtotal that runInstantly already wrote. Avoids the two
    // sources clobbering each other.
    const earliestKey = mondayKeys[0];
    const { data: existingMetrics } = await sb
      .from('weekly_metrics')
      .select('client_id, week_key, emails_sent, replies')
      .gte('week_key', earliestKey);
    const existingByKey = new Map<string, { emails_sent: number; replies: number }>();
    for (const m of (existingMetrics ?? []) as { client_id: string; week_key: string; emails_sent: number; replies: number }[]) {
      existingByKey.set(`${m.client_id}|${m.week_key}`, {
        emails_sent: m.emails_sent ?? 0,
        replies: m.replies ?? 0,
      });
    }

    const upserts = bisonWeeklyUpserts(
      clients as { id: string; bison_campaign_ids: string[] }[],
      mondayKeys,
      campaignWeekly,
      existingByKey,
    );

    if (upserts.length > 0) {
      const { error } = await sb
        .from('weekly_metrics')
        .upsert(upserts, { onConflict: 'client_id,week_key', ignoreDuplicates: false });
      if (error) throw new Error(error.message);
    }

    await finishRun(sb, run?.id);
    return { ok: true, campaigns: campaignRows.length, weeksBackfilled: mondayKeys.length };
  } catch (err) {
    const message = (err as Error).message;
    await finishRun(sb, run?.id, message);
    return { ok: false, error: message };
  }
}

/**
 * Bison's weekly rows: ADDED to the Instantly subtotal already on file, and
 * only emitted where Bison actually sent or received something — an
 * all-zero row would otherwise overwrite Instantly's figure with itself.
 */
export function bisonWeeklyUpserts(
  clients: { id: string; bison_campaign_ids: string[] }[],
  mondayKeys: string[],
  campaignWeekly: Map<string, Map<string, { sent: number; replies: number }>>,
  existingByKey: Map<string, { emails_sent: number; replies: number }>,
): { client_id: string; week_key: string; emails_sent: number; replies: number }[] {
  const upserts: { client_id: string; week_key: string; emails_sent: number; replies: number }[] = [];
  for (const c of clients) {
    for (const wk of mondayKeys) {
      let bisonSent = 0;
      let bisonReplies = 0;
      for (const cid of c.bison_campaign_ids ?? []) {
        const b = campaignWeekly.get(cid)?.get(wk);
        if (b) { bisonSent += b.sent; bisonReplies += b.replies; }
      }
      if (bisonSent === 0 && bisonReplies === 0) continue;
      const prev = existingByKey.get(`${c.id}|${wk}`) ?? { emails_sent: 0, replies: 0 };
      upserts.push({
        client_id: c.id,
        week_key: wk,
        emails_sent: prev.emails_sent + bisonSent,
        replies: prev.replies + bisonReplies,
      });
    }
  }
  return upserts;
}

/** The tool's rule: both Corofy variables, or the whole Corofy step is skipped. */
export function corofyConfigured(env: (name: string) => string | undefined = optionalEnv): boolean {
  return Boolean(env('CLIENT_HEALTH_COROFY_ADMIN_TOKEN') && env('CLIENT_HEALTH_COROFY_BASE_URL'));
}

/**
 * Corofy rows bucketed by (normalized client_name, week_key). Normalization
 * collapses punctuation/whitespace drift so "C21 Results - Elite Team"
 * (Corofy) maps to "C21 Results Elite Team" (our clients.name). Alias names
 * collapse to their primary — see CLIENT_NAME_ALIASES.
 *
 * Shared by the Introduction, Interested and Hired passes; each reads the
 * parts it needs.
 */
export interface WeekBuckets {
  byNameWeek: Map<string, { count: number; latest: number }>;
  /** Newest assigned_at per client, across ALL time — not clipped to the window. */
  allTimeLatest: Map<string, number>;
  /** Row count per client, across ALL time. */
  allTimeCount: Map<string, number>;
  /** First-seen original spelling per normalized name, for the unmatched warning. */
  seenOriginalByNormalized: Map<string, string>;
}

export function bucketByNameWeek(rows: CorofyIntro[], validWeekSet: Set<string>): WeekBuckets {
  const byNameWeek = new Map<string, { count: number; latest: number }>();
  const allTimeLatest = new Map<string, number>();
  const allTimeCount = new Map<string, number>();
  const seenOriginalByNormalized = new Map<string, string>();
  for (const i of rows) {
    const t = new Date(i.assigned_at).getTime();
    if (!Number.isFinite(t)) continue;
    const normKey = normalizeClientName(i.client_name);
    if (!seenOriginalByNormalized.has(normKey)) {
      seenOriginalByNormalized.set(normKey, i.client_name);
    }
    if ((allTimeLatest.get(normKey) ?? 0) < t) allTimeLatest.set(normKey, t);
    allTimeCount.set(normKey, (allTimeCount.get(normKey) ?? 0) + 1);

    const wk = weekKey(new Date(t));
    if (!validWeekSet.has(wk)) continue;
    const k = `${normKey}|${wk}`;
    const cur = byNameWeek.get(k) ?? { count: 0, latest: 0 };
    cur.count++;
    if (t > cur.latest) cur.latest = t;
    byNameWeek.set(k, cur);
  }
  return { byNameWeek, allTimeLatest, allTimeCount, seenOriginalByNormalized };
}

/**
 * One weekly_metrics row per client × week for a label. Always emitted, even
 * at zero, so weeks with no current rows are reset (otherwise a deletion on
 * the Corofy side would never clear our cached count). The timestamp column
 * falls back to the client's all-time latest when the week itself had none.
 */
export function labelWeeklyUpserts<C extends string, T extends string>(
  clients: { id: string; name: string }[],
  mondayKeys: string[],
  buckets: WeekBuckets,
  countColumn: C,
  tsColumn: T,
): Array<{ client_id: string; week_key: string } & Record<C, number> & Record<T, string | null>> {
  const upserts: Array<{ client_id: string; week_key: string } & Record<C, number> & Record<T, string | null>> = [];
  for (const c of clients) {
    const normKey = normalizeName(c.name);
    const allTime = buckets.allTimeLatest.get(normKey) ?? 0;
    for (const wk of mondayKeys) {
      const stats = buckets.byNameWeek.get(`${normKey}|${wk}`);
      const count = stats?.count ?? 0;
      const latest = stats?.latest ?? 0;
      const ts = latest > 0 ? latest : allTime;
      upserts.push({
        client_id: c.id,
        week_key: wk,
        [countColumn]: count,
        [tsColumn]: ts > 0 ? new Date(ts).toISOString() : null,
      } as { client_id: string; week_key: string } & Record<C, number> & Record<T, string | null>);
    }
  }
  return upserts;
}

export interface BillingClient {
  id: string;
  name: string;
  billing_anchor_date: string | null;
  billing_interval: 'biweekly' | '28-days' | 'monthly' | 'custom' | null;
  billing_interval_days: number | null;
  start_date: string | null;
}

/**
 * The per-client Introduction metrics that live on the clients table (not
 * weekly_metrics):
 *
 *   intros_since_last_billing = intros whose assigned_at falls on/after
 *     the client's most recent billing anchor cycle. Powers the Bi-Weekly
 *     "Introductions (since last billing)" column. Falls back to
 *     start_date when billing_anchor_date is null (same rule the
 *     Bi-Weekly UI uses today).
 *
 *   stagnant_intros_count = intros where client_activity_at IS NULL
 *     (i.e. the client has never taken a portal action on this lead
 *     since we assigned it). Excludes FUB auto-push and other server
 *     automations — Corofy's client_activity_at trigger is the source
 *     of truth. Falls back to the older `updated_at ≈ assigned_at`
 *     heuristic for Corofy deployments that predate client_activity_at.
 *
 *   intros_this_month = intros on/after the monthly cycle start, which is
 *     independent of billing_interval — see monthlyCycleStart.
 *
 * All three are graceful when Corofy fields are missing.
 */
export function clientIntroCounts(
  clientIntros: CorofyIntro[],
  c: Omit<BillingClient, 'id' | 'name'>,
  nowMs: number,
): { intros_since_last_billing: number; stagnant_intros_count: number; intros_this_month: number; total_intros_corofy: number } {
  const anchor = c.billing_anchor_date ?? c.start_date;
  const interval = c.billing_interval ?? 'biweekly';
  const lastBilling = lastBillingDate(anchor, interval, new Date(nowMs), c.billing_interval_days);
  // Monthly cycle: independent of billing_interval — walks calendar
  // months from the same anchor. Powers the Weekly view's "Monthly"
  // column so a biweekly-billed client still gets a stable monthly
  // window (anchor day-of-month → next anchor day-of-month).
  const monthStart = monthlyCycleStart(anchor, new Date(nowMs));
  let intrsSince = 0;
  let stagnant = 0;
  let intrsMonth = 0;
  // Current cycle starts the DAY AFTER the last billing day (the
  // billing day itself belongs to the outgoing cycle — that's when the
  // client is charged for it). Add 86.4M ms (24h) to skip the whole
  // billing day. lastBillingDate returns midnight UTC, so + 1 day
  // lands cleanly at midnight of the next day.
  const cycleStartMs = lastBilling ? lastBilling.getTime() + 86_400_000 : 0;
  const monthStartMs = monthStart ? monthStart.getTime() : 0;
  for (const r of clientIntros) {
    const aMs = new Date(r.assigned_at).getTime();
    if (Number.isFinite(aMs) && cycleStartMs > 0 && aMs >= cycleStartMs) intrsSince++;
    // Monthly-cycle-start is INCLUSIVE (anchor day is the first day of
    // the new monthly cycle, unlike billing day which is the last day
    // of the outgoing cycle).
    if (Number.isFinite(aMs) && monthStartMs > 0 && aMs >= monthStartMs) intrsMonth++;
    // Prefer Corofy's client_activity_at (null == stagnant); fall back
    // to the old updated_at heuristic when the field is absent.
    if ('client_activity_at' in r) {
      if (r.client_activity_at == null) stagnant++;
    } else if (r.updated_at) {
      const uMs = new Date(r.updated_at).getTime();
      if (Number.isFinite(uMs) && uMs - aMs < 2000) stagnant++;
    }
  }
  return {
    intros_since_last_billing: intrsSince,
    stagnant_intros_count: stagnant,
    intros_this_month: intrsMonth,
    // All-time Introduction count for this client, no 26-week clip.
    // Powers the Funnel — Lifetime "Converted" number so it isn't
    // truncated when a client has history older than the backfill.
    total_intros_corofy: clientIntros.length,
  };
}

/**
 * Interested rows attributed to campaigns in our cache. Corofy's campaign_id
 * is an Instantly UUID for some records or a Bison integer id (as string) for
 * others; both cache tables are keyed here by the string Corofy sends.
 */
export function interestedByCampaign(rows: CorofyIntro[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const cid = r.campaign_id;
    if (!cid) continue;
    out.set(cid, (out.get(cid) ?? 0) + 1);
  }
  return out;
}

export async function runCorofy(ctx: RunContext): Promise<SyncResult['corofy']> {
  if (!corofyConfigured()) {
    return { ok: true, skipped: true };
  }

  const sb = ctx.db;
  const { data: run } = await sb
    .from('sync_runs')
    .insert({ source: 'corofy' })
    .select('id')
    .single();

  try {
    const intros = await listCorofyIntros();
    const { mondayKeys } = backfillWindow(ctx.now);
    const validWeekSet = new Set(mondayKeys);

    const introBuckets = bucketByNameWeek(intros, validWeekSet);
    const { seenOriginalByNormalized } = introBuckets;

    // Also pull billing fields so we can compute per-client
    // intros_since_last_billing (see the second pass below).
    const { data: clients } = await sb
      .from('clients')
      .select('id, name, billing_anchor_date, billing_interval, billing_interval_days, start_date');
    const matchedNormalized = new Set<string>();
    if (clients) {
      for (const c of clients as { id: string; name: string }[]) {
        const normKey = normalizeName(c.name);
        if (seenOriginalByNormalized.has(normKey)) matchedNormalized.add(normKey);
      }
      const upserts = labelWeeklyUpserts(
        clients as { id: string; name: string }[],
        mondayKeys,
        introBuckets,
        'intros_corofy',
        'last_corofy_intro_at',
      );
      if (upserts.length > 0) {
        const { error } = await sb
          .from('weekly_metrics')
          .upsert(upserts, { onConflict: 'client_id,week_key', ignoreDuplicates: false });
        if (error) throw new Error(error.message);
      }

      // Second pass over the same `intros` array to derive the per-client
      // metrics that live on the clients table — see clientIntroCounts.
      const nowMs = ctx.now.getTime();
      const introsByNorm = new Map<string, CorofyIntro[]>();
      for (const i of intros) {
        const k = normalizeClientName(i.client_name);
        let bucket = introsByNorm.get(k);
        if (!bucket) { bucket = []; introsByNorm.set(k, bucket); }
        bucket.push(i);
      }
      let cfWriteErrors = 0;
      for (const c of clients as BillingClient[]) {
        const normKey = normalizeName(c.name);
        const clientIntros = introsByNorm.get(normKey) ?? [];
        const { error } = await sb
          .from('clients')
          .update(clientIntroCounts(clientIntros, c, nowMs))
          .eq('id', c.id);
        if (error) {
          cfWriteErrors++;
          if (cfWriteErrors <= 3) {
            console.warn(`[corofy] client-field update failed for ${c.name}: ${error.message}`);
          }
        }
      }
      if (cfWriteErrors > 3) {
        console.warn(`[corofy] ...${cfWriteErrors - 3} more client-field update errors suppressed`);
      }
    }

    // Surface ORIGINAL Corofy names (not normalized) so the warning is human-readable.
    const unmatched = [...seenOriginalByNormalized.entries()]
      .filter(([norm]) => !matchedNormalized.has(norm))
      .map(([, original]) => original);
    if (unmatched.length > 0) {
      console.warn(
        `[corofy] ${unmatched.length} client name(s) from Corofy did not match any clients.name: ${unmatched.join(', ')}`
      );
    }

    // Now do the same thing for the "Interested" label and write
    // interested_corofy / last_interested_at on the same weekly_metrics rows.
    // Failures here are non-fatal: log and continue (Introduction data already
    // written; portal sync still runs).
    let interestedTotal = 0;
    try {
      const interestedRows = await listCorofyIntros('Interested');
      interestedTotal = interestedRows.length;
      const interestedBuckets = bucketByNameWeek(interestedRows, validWeekSet);
      if (clients) {
        const interestedUpserts = labelWeeklyUpserts(
          clients as { id: string; name: string }[],
          mondayKeys,
          interestedBuckets,
          'interested_corofy',
          'last_interested_at',
        );
        if (interestedUpserts.length > 0) {
          const { error } = await sb
            .from('weekly_metrics')
            .upsert(interestedUpserts, { onConflict: 'client_id,week_key', ignoreDuplicates: false });
          if (error) console.warn(`[corofy] interested upsert failed: ${error.message}`);
        }
        // Persist all-time Interested counts on the clients table so the
        // dashboard's Funnel Lifetime numerator isn't clipped by the 26-week
        // weekly_metrics backfill window.
        for (const c of clients as { id: string; name: string }[]) {
          const normKey = normalizeName(c.name);
          const total = interestedBuckets.allTimeCount.get(normKey) ?? 0;
          const { error } = await sb
            .from('clients')
            .update({ total_interested_corofy: total })
            .eq('id', c.id);
          if (error) console.warn(`[corofy] total_interested_corofy update failed for ${c.name}: ${error.message}`);
        }
      }
      console.warn(`[corofy] Interested rows bucketed: ${interestedTotal}`);

      // Also attribute Interested rows to specific campaigns in our cache.
      // Corofy's campaign_id is an Instantly UUID for some records or a Bison
      // integer id (as string) for others. We bucket by campaign_id and write
      // interested_count on each campaign-cache table.
      const byCampaign = interestedByCampaign(interestedRows);
      let instMatched = 0;
      let bisonMatched = 0;
      const { data: instCampaigns } = await sb.from('instantly_campaigns').select('id');
      for (const ic of (instCampaigns ?? []) as { id: string }[]) {
        const n = byCampaign.get(ic.id) ?? 0;
        const { error } = await sb
          .from('instantly_campaigns')
          .update({ interested_count: n })
          .eq('id', ic.id);
        if (!error && n > 0) instMatched++;
      }
      const { data: bisonCampaignRows } = await sb
        .from('bison_campaigns')
        .select('id, int_id');
      for (const bc of (bisonCampaignRows ?? []) as { id: string; int_id: number | null }[]) {
        if (bc.int_id == null) continue;
        const n = byCampaign.get(String(bc.int_id)) ?? 0;
        const { error } = await sb
          .from('bison_campaigns')
          .update({ interested_count: n })
          .eq('id', bc.id);
        if (!error && n > 0) bisonMatched++;
      }
      console.warn(
        `[corofy] Interested per-campaign attribution: instantly=${instMatched} bison=${bisonMatched} (of ${byCampaign.size} distinct Corofy campaign_ids)`,
      );
    } catch (e) {
      console.warn(`[corofy] Interested fetch failed: ${(e as Error).message}`);
    }

    // Repeat the same shape for the "Hired" label. Fully non-fatal: the
    // Corofy workspace may not have this label defined yet, in which case
    // the endpoint 404s with `Label "Hired" not found`. We log & skip so
    // Introduction / Interested / portals all still succeed.
    let hiredTotal = 0;
    let hiredSkipped = false;
    try {
      const hiredRows = await listCorofyIntros('Hired');
      hiredTotal = hiredRows.length;
      const hiredBuckets = bucketByNameWeek(hiredRows, validWeekSet);
      if (clients) {
        const hiredUpserts = labelWeeklyUpserts(
          clients as { id: string; name: string }[],
          mondayKeys,
          hiredBuckets,
          'hired_corofy',
          'last_hired_at',
        );
        if (hiredUpserts.length > 0) {
          const { error } = await sb
            .from('weekly_metrics')
            .upsert(hiredUpserts, { onConflict: 'client_id,week_key', ignoreDuplicates: false });
          if (error) console.warn(`[corofy] hired upsert failed: ${error.message}`);
        }
      }
      console.warn(`[corofy] Hired rows bucketed: ${hiredTotal}`);
    } catch (e) {
      const msg = (e as Error).message;
      // Corofy returns 404 "Label X not found" when the label doesn't exist
      // in the workspace. Downgrade this to an info log — it's expected until
      // someone creates the label upstream.
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        hiredSkipped = true;
        console.warn('[corofy] Hired label not present in workspace — skipping');
      } else {
        console.warn(`[corofy] Hired fetch failed: ${msg}`);
      }
    }

    // Piggyback portal sync on the same tick. In the tool this had to run from
    // the sync-worker's Railway edge; here it is the workspace's own Master
    // Inbox route, in-process — see portals.ts. Failures are non-fatal: we
    // log and keep the existing portal_active values.
    let portalsMatched = 0;
    try {
      const portals = await listCorofyPortals();
      if (portals.length > 0) {
        // Index portals by normalized name so we can look up the counts per
        // client (not just active/inactive). One index entry per name AND
        // per alias, all pointing back to the same portal record.
        const activeNames = new Set<string>();
        const portalByNormName = new Map<string, typeof portals[number]>();
        for (const p of portals) {
          portalByNormName.set(normalizeName(p.name), p);
          for (const a of p.aliases ?? []) portalByNormName.set(normalizeName(a), p);
          if (p.portal_enabled) {
            activeNames.add(normalizeName(p.name));
            for (const a of p.aliases ?? []) activeNames.add(normalizeName(a));
          }
        }
        const { data: allClients } = await sb.from('clients').select('id, name');
        const now = new Date().toISOString();
        // Use .update() per row instead of .upsert() — Supabase upsert validates
        // each row as a candidate INSERT, which trips clients.name NOT NULL even
        // though every id we have here exists. .update().eq('id', ...) skips
        // the INSERT path entirely.
        let updateErrors = 0;
        for (const c of (allClients ?? []) as { id: string; name: string }[]) {
          const norm = normalizeName(c.name);
          const active = activeNames.has(norm);
          if (active) portalsMatched++;
          // Mirror the DNC + Agents counts from Corofy. Zero when the client
          // isn't in the portals response at all, or when Corofy didn't
          // return counts (rare — the field is opt-in in their payload).
          const portal = portalByNormName.get(norm);
          const dncCount = portal?.counts?.dnc ?? 0;
          const agentsCount = portal?.counts?.agents ?? 0;
          // Corofy's per-portal "most recent CLIENT-driven action" timestamp.
          // Field always present now — null means genuine "no client engagement",
          // which we surface as "—" in the UI. Do NOT fall back to the older
          // last_lead_activity_at: that would mask Corofy's authoritative null
          // with a FUB-polluted timestamp from before the client_activity_at
          // rollout.
          const lastActivity = portal?.last_client_activity_at ?? null;
          // Portal deep-link — mirrored so the dashboard can render a link-out
          // icon next to the client name without hitting Corofy's API from the
          // browser.
          const portalUrl = portal?.portal_url ?? null;
          const { error } = await sb
            .from('clients')
            .update({
              portal_active: active,
              portal_synced_at: now,
              dnc_count: dncCount,
              agents_count: agentsCount,
              last_lead_activity_at: lastActivity,
              portal_url: portalUrl,
            })
            .eq('id', c.id);
          if (error) {
            updateErrors++;
            if (updateErrors <= 3) {
              console.warn(`[corofy] portal update failed for ${c.name}: ${error.message}`);
            }
          }
        }
        if (updateErrors > 3) {
          console.warn(`[corofy] ...${updateErrors - 3} more portal update errors suppressed`);
        }
        console.warn(`[corofy] portals synced: ${portalsMatched}/${(allClients ?? []).length} clients active (${updateErrors} write errors)`);
      } else {
        console.warn('[corofy] portals fetch returned empty — leaving portal_active values unchanged');
      }
    } catch (e) {
      console.warn(`[corofy] portals sync failed: ${(e as Error).message}`);
    }

    await finishRun(sb, run?.id);
    return {
      ok: true,
      intros: intros.length,
      interested: interestedTotal,
      hired: hiredTotal,
      hiredSkipped: hiredSkipped || undefined,
      unmatched: unmatched.length > 0 ? unmatched : undefined,
      portalsMatched,
    };
  } catch (err) {
    const message = (err as Error).message;
    await finishRun(sb, run?.id, message);
    return { ok: false, error: message };
  }
}
