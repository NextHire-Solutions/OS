import "server-only";

import { createEmailBisonClient, EmailBisonApiError } from "@/lib/tools/analytics/emailbison/client.ts";

import { toISODate } from "./query-params.ts";
import { analyticsTeamId, fetchAllRows, getAnalyticsSupabase } from "./supabase";
import { SENDING_STATUSES, pooled, resolveAssigned, score, warmupRange, type InboxExtras } from "./inbox-extras.ts";

/*
 * Warmup scores and exact campaign assignment for the Inboxes page, read from
 * EmailBison in the background (inbox-extras.ts has the rules and the why).
 *
 * ---------------------------------------------------------------------------
 * HOW IT RUNS
 *
 * Nothing is scheduled. The first time someone opens Inboxes the read starts
 * and the page is told "loading"; it polls, and the columns fill in when the
 * read finishes — about 700 GET requests, a few minutes, three at a time so
 * the rate-limit gate (emailbison/rate-limit.ts) stays free for whatever else
 * the workspace is doing. The answer is then kept for six hours. After that
 * the next visit gets the old answer AT ONCE and starts a fresh read behind
 * it, so nobody waits twice.
 *
 * Kept in the process, not the database: there is no table for it, and adding
 * one needs a migration. A restart simply reads again on the next visit.
 *
 * READ-ONLY. Every request here is a GET.
 */

const TTL_MS = 6 * 60 * 60 * 1000;
/** After a failed read, wait this long before the next visit tries again. */
const RETRY_MS = 5 * 60 * 1000;
/** Requests in flight at once. The gate allows 12; this leaves it room. */
const CONCURRENCY = 3;

interface State {
  value: InboxExtras | null;
  reading: Promise<void> | null;
  progress: { step: string; done: number; total: number } | null;
  error: string | null;
  failedAt: number | null;
}

// One state for the whole process — Next builds this module more than once
// (see cache/ttl.ts `shared`), and two copies would each run the 700 requests.
const SLOT = Symbol.for("os.analytics.inboxExtras");
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[SLOT] ??= { value: null, reading: null, progress: null, error: null, failedAt: null });
}

async function read(s: State): Promise<InboxExtras> {
  const eb = createEmailBisonClient();
  const sb = getAnalyticsSupabase();
  const teamId = analyticsTeamId();
  const today = toISODate(new Date());

  /* Warmup: two date ranges, each a numbered walk read three pages at a time. */
  const warmup: InboxExtras["warmup"] = {};
  const current = new Set<number>();
  for (const [slot, days] of [[0, 3], [1, 7]] as const) {
    const { start, end } = warmupRange(today, days);
    const take = (rows: Array<{ id: number; warmup_score: number | null }> | undefined) => {
      for (const r of rows ?? []) {
        const id = Number(r.id);
        if (!Number.isFinite(id)) continue;
        current.add(id);
        (warmup[String(id)] ??= [null, null])[slot] = score(r.warmup_score);
      }
    };
    const first = await eb.getWarmupScoresPage(start, end, 1);
    take(first.data);
    const last = Math.max(1, Number(first.meta?.last_page ?? 1));
    let done = 1;
    s.progress = { step: `Warmup score, ${days} days`, done, total: last };
    await pooled(Array.from({ length: last - 1 }, (_, i) => i + 2), CONCURRENCY, async (page) => {
      take((await eb.getWarmupScoresPage(start, end, page)).data);
      s.progress = { step: `Warmup score, ${days} days`, done: ++done, total: last };
    });
  }

  /*
   * Assigned. The inboxes to settle are the ones EmailBison itself just listed
   * — the database still holds some it has since deleted, and asking EmailBison
   * about those would be a 404 each.
   */
  const campaigns = await fetchAllRows<{ id: number }>((from, to) =>
    sb.from("campaigns").select("id").eq("team_id", teamId).is("deleted_at", null)
      .in("status", [...SENDING_STATUSES]).order("id", { ascending: true }).range(from, to),
  );
  s.progress = { step: "Inboxes on campaigns", done: 0, total: 1 };
  const assigned = await resolveAssigned({
    inboxIds: [...current],
    campaignIds: campaigns.map((c) => Number(c.id)),
    concurrency: CONCURRENCY,
    inboxesOf: async (campaignId) => (await eb.getCampaignSenderEmails(campaignId)).map((i) => Number(i.id)),
    campaignsOf: async (inboxId) => {
      try {
        return await eb.getSenderEmailCampaigns(inboxId);
      } catch (e) {
        // Deleted between the two reads: it is on no campaign.
        if (e instanceof EmailBisonApiError && e.statusCode === 404) return [];
        throw e;
      }
    },
    onProgress: (done, total) => { s.progress = { step: "Inboxes on campaigns", done, total }; },
  });

  return { warmup, assigned: [...assigned], asOf: new Date().toISOString() };
}

export interface InboxExtrasSnapshot {
  /** ready: use `extras`. loading: nothing yet. refreshing: `extras` is the previous read. error: see `error`. */
  status: "ready" | "loading" | "refreshing" | "error";
  extras: InboxExtras | null;
  progress: State["progress"];
  error: string | null;
}

/** What is known right now — and, if that is nothing or is stale, starts a read behind the answer. */
export function inboxExtras(now = Date.now()): InboxExtrasSnapshot {
  const s = state();
  const fresh = s.value !== null && now - Date.parse(s.value.asOf) < TTL_MS;
  const coolingOff = s.failedAt !== null && now - s.failedAt < RETRY_MS;

  if (!fresh && !s.reading && !coolingOff) {
    s.error = null;
    s.reading = read(s)
      .then((value) => { s.value = value; s.failedAt = null; })
      .catch((e: unknown) => {
        s.error = e instanceof Error ? e.message : "EmailBison did not answer";
        s.failedAt = Date.now();
        console.error("[analytics] inbox extras:", s.error);
      })
      .finally(() => { s.reading = null; s.progress = null; });
  }

  return {
    status: s.reading ? (s.value ? "refreshing" : "loading") : s.value ? "ready" : "error",
    extras: s.value,
    progress: s.progress,
    error: s.reading ? null : s.error,
  };
}
