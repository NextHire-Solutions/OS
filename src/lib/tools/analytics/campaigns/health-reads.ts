import "server-only";

import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";

import { HEALTH_WINDOW_DAYS, WARMUP_WINDOW_DAYS, type RecentBounces, type SourceInbox } from "./renew/inbox-health.ts";

/*
 * The reads behind the inbox health rules (renew/inbox-health.ts), shared by Duplicate & Renew, the Inboxes page's
 * "Add to campaigns" and the Campaigns page's "Assign" (20 Nov), so all three judge an inbox on the same figures.
 */

const WARMUP_PAGES_AT_ONCE = 25;

export type WarmupScores = Map<number, { score: number | null; sent: number }>;

/*
 * EmailBison's warm-up score for every inbox (20 Nov: the team's extra health check). The warm-up list is 15 inboxes a
 * page (~155 pages for the workspace), held 30 minutes for everything in this process. COMPLETE or an error: an inbox
 * missing from the list would count as "too little warm-up mail to judge" and go on unchecked, so a list shorter than
 * EmailBison's own total is read once more, and refused if still short. A score EmailBison leaves empty stays empty
 * (unjudged), never 0.
 */
export async function readWarmupScores(request: <T>(path: string) => Promise<T>, today = new Date()): Promise<WarmupScores> {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const start = new Date(today.getTime() - WARMUP_WINDOW_DAYS * 86_400_000);
  type Page = { data?: Array<{ id: number; warmup_score?: number | null; warmup_emails_sent?: number | null }>; meta?: { last_page?: number; total?: number } };
  const page = (n: number) => request<Page>(`/api/warmup/sender-emails?start_date=${day(start)}&end_date=${day(today)}&page=${n}`);
  const readAll = async () => {
    const first = await page(1);
    const total = Number(first?.meta?.total);
    const last = Number(first?.meta?.last_page);
    if (!Number.isFinite(total) || !Number.isFinite(last) || last < 1) throw new Error("EmailBison's warm-up list didn't say how long it is");
    const out: WarmupScores = new Map();
    const take = (p: Page) => {
      for (const r of p?.data ?? []) {
        const s = r.warmup_score;
        out.set(Number(r.id), { score: s === null || s === undefined || !Number.isFinite(Number(s)) ? null : Number(s), sent: Number(r.warmup_emails_sent ?? 0) });
      }
    };
    take(first);
    // 25 pages at a time: ~7 rounds for the workspace (10 at a time took ~20 s, measured 20 Nov), well inside EmailBison's rate.
    for (let n = 2; n <= last; n += WARMUP_PAGES_AT_ONCE) {
      const pages = await Promise.all(Array.from({ length: Math.min(WARMUP_PAGES_AT_ONCE, last - n + 1) }, (_, i) => page(n + i)));
      pages.forEach(take);
    }
    return { out, total };
  };
  let r = await readAll();
  // Inboxes added or removed while it was read shift the pages: read again once.
  if (r.out.size < r.total) r = await readAll();
  if (r.out.size < r.total) throw new Error(`EmailBison's warm-up list came back short (${r.out.size} of ${r.total} inboxes)`);
  return r.out;
}

export const warmupScores = ttlCache(async (): Promise<WarmupScores> => {
  const eb = createEmailBisonClient();
  return readWarmupScores((path) => eb.request(path));
}, {
  ttlMs: 30 * 60_000,
  key: () => "all",
  shared: "renew-warmup-scores",
  // The whole list takes ~10-20 s; the cache's default 12 s in-flight limit dropped every read that ran longer, so
  // nothing was ever kept and every check read all ~155 pages again (independent review, 20 Nov).
  inflightTimeoutMs: 120_000,
});

/** Sends and bounces over the last 30 days (analytics 098). "missing" when 098 hasn't been run. */
export async function recentBounces(ids: number[]): Promise<RecentBounces[] | "missing"> {
  const { data, error } = await getAnalyticsSupabase().rpc("analytics_os_inbox_recent_bounces", { p_team_id: analyticsTeamId(), p_sender_ids: ids, p_days: HEALTH_WINDOW_DAYS });
  if (error) {
    if (/analytics_os_inbox_recent_bounces|schema cache|does not exist|PGRST202/i.test(`${error.code ?? ""} ${error.message}`)) return "missing";
    throw new Error(`Recent bounces: ${error.message}`);
  }
  return ((Array.isArray(data) ? data : []) as Array<{ id: unknown; sent: unknown; bounced: unknown; sent_24h?: unknown }>).map((r): RecentBounces => ({
    id: Number(r.id), sent: Number(r.sent ?? 0), bounced: Number(r.bounced ?? 0), sent24h: Number(r.sent_24h ?? 0),
  }));
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** These inboxes as the inbox sync last read them (status, tags, daily limit). A deleted one isn't returned. */
export async function inboxesById(ids: number[]): Promise<SourceInbox[]> {
  const sb = getAnalyticsSupabase();
  const out: SourceInbox[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await sb
      .from("sender_emails")
      .select("id, email, status, daily_limit, tags")
      .eq("team_id", analyticsTeamId())
      .is("archived_at", null)
      .in("id", ids.slice(i, i + 500));
    if (error) throw new Error(`Inboxes: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: unknown; email: unknown; status: unknown; daily_limit: unknown; tags: unknown }>) {
      out.push({
        id: Number(r.id),
        email: String(r.email ?? ""),
        status: r.status === null || r.status === undefined ? null : String(r.status),
        dailyLimit: num(r.daily_limit),
        tags: (Array.isArray(r.tags) ? r.tags : []).map((t) => (typeof t === "string" ? t : String((t as { name?: unknown })?.name ?? ""))).filter(Boolean),
      });
    }
  }
  return out;
}
