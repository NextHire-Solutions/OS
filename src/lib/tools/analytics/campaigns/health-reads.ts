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

/*
 * EmailBison's warm-up score for every inbox (20 Nov: the team's extra health check). The warm-up list is 15 inboxes a
 * page (~200 pages for the workspace); held 30 minutes for everything in this process, so a second check of the
 * day pays nothing. Every page or an error: half a list would leave inboxes unjudged.
 */
export const warmupScores = ttlCache(async (): Promise<Map<number, { score: number; sent: number }>> => {
  const eb = createEmailBisonClient();
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const end = new Date();
  const start = new Date(end.getTime() - WARMUP_WINDOW_DAYS * 86_400_000);
  type Page = { data?: Array<{ id: number; warmup_score?: number | null; warmup_emails_sent?: number | null }>; meta?: { last_page?: number } };
  const page = (n: number) => eb.request<Page>(`/api/warmup/sender-emails?start_date=${day(start)}&end_date=${day(end)}&page=${n}`);
  const first = await page(1);
  const last = Math.max(1, Number(first?.meta?.last_page ?? 1));
  const out = new Map<number, { score: number; sent: number }>();
  const take = (p: Page) => { for (const r of p?.data ?? []) out.set(Number(r.id), { score: Number(r.warmup_score ?? 0), sent: Number(r.warmup_emails_sent ?? 0) }); };
  take(first);
  // 25 pages at a time: ~8 rounds for the workspace (10 at a time took ~20 s, measured 20 Nov), well inside EmailBison's rate.
  for (let n = 2; n <= last; n += WARMUP_PAGES_AT_ONCE) {
    const pages = await Promise.all(Array.from({ length: Math.min(WARMUP_PAGES_AT_ONCE, last - n + 1) }, (_, i) => page(n + i)));
    pages.forEach(take);
  }
  return out;
}, { ttlMs: 30 * 60_000, key: () => "all", shared: "renew-warmup-scores" });

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
