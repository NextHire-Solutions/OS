import "server-only";

import { randomUUID } from "node:crypto";

import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client.ts";
import { EmailBisonApiError, describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors.ts";
import { analyticsTeamId, getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { introSenderEmail } from "@/lib/tools/master-inbox/inbox/intro-sender";

import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";

import { HEALTH_WINDOW_DAYS, WARMUP_WINDOW_DAYS, type RecentBounces, type SourceInbox } from "./inbox-health.ts";
import type { CampaignLeadRow } from "./leads.ts";
import { linkStore } from "./links-store.ts";
import { moveLinks, readLinks } from "./links.ts";
import type { ClientPin, LastRenewal, RenewAudit, RenewCampaign, RenewIO, RenewSchedule } from "./renew.ts";

/*
 * The real reads and writes behind renew.ts: EmailBison (the authority on the
 * campaign, its leads and inboxes), analytics 098 (recent bounces), the OS
 * links (links-store.ts) and the analytics audit log.
 */

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
/** Page numbers stop at 1,000 (15,000 leads); past that the cursor walk is used. */
const PAGE_LIMIT = 1000;
/** Pages read at once; the client's own gate paces EmailBison underneath. */
const PAGES_AT_ONCE = 10;
const WARMUP_PAGES_AT_ONCE = 25;

/*
 * EmailBison's warm-up score for every inbox (20 Nov: the team's extra health check). The warm-up list is 15 inboxes a
 * page (~200 pages for the workspace), read 10 pages at a time; held 30 minutes for every review in this process, so a
 * second review of the day pays nothing. Every page or an error: half a list would leave inboxes unjudged.
 */
const warmupScores = ttlCache(async (): Promise<Map<number, { score: number; sent: number }>> => {
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

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** EmailBison's answer when it adds none of the leads asked for (measured 19 Nov: HTTP 422). */
export function isAllRefused(error: unknown): boolean {
  return error instanceof EmailBisonApiError && error.statusCode === 422 && /No leads were added/i.test(describeEmailBisonError(error));
}

/** EmailBison's answer when every inbox asked for is already on the campaign (HTTP 200, success false). */
function isAllAlreadyOn(error: unknown): boolean {
  return error instanceof EmailBisonApiError && /already exist/i.test(describeEmailBisonError(error));
}

export function realRenewIO(): RenewIO {
  const eb = createEmailBisonClient();
  const sb = getAnalyticsSupabase();
  const teamId = analyticsTeamId();
  // One id for the run's "started" and "finished" audit rows.
  const batch = randomUUID();

  /** Every page of a numbered list, PAGES_AT_ONCE at a time; past PAGE_LIMIT pages, the cursor walk instead. */
  async function allPages<T>(read: (page: number) => Promise<{ rows: T[]; lastPage: number }>, byCursor: () => Promise<T[]>): Promise<T[]> {
    const first = await read(1);
    if (first.lastPage > PAGE_LIMIT) return byCursor();
    const rows: T[] = [...first.rows];
    const pages = Array.from({ length: Math.max(0, first.lastPage - 1) }, (_, i) => i + 2);
    for (let i = 0; i < pages.length; i += PAGES_AT_ONCE) {
      for (const got of await Promise.all(pages.slice(i, i + PAGES_AT_ONCE).map(read))) rows.push(...got.rows);
    }
    return rows;
  }

  const leadRows = (id: number): Promise<CampaignLeadRow[]> =>
    allPages<CampaignLeadRow>((p) => eb.getCampaignLeadsPage(id, p), async () => (await eb.getAllCampaignLeadRows(id)) as CampaignLeadRow[]);

  return {
    async campaign(id) {
      try {
        const c = await eb.getCampaign(id);
        if (!c?.id) return null;
        const tags = (c.tags ?? [])
          .map((t) => (typeof t === "string" ? null : { id: Number(t.id), name: String(t.name ?? "") }))
          .filter((t): t is { id: number; name: string } => !!t && Number.isInteger(t.id) && !!t.name);
        const out: RenewCampaign = {
          id: Number(c.id), name: String(c.name ?? ""), status: String(c.status ?? ""), tags,
          maxEmailsPerDay: num(c.max_emails_per_day), maxNewLeadsPerDay: num(c.max_new_leads_per_day),
        };
        return out;
      } catch (e) {
        if (e instanceof EmailBisonApiError && e.statusCode === 404) return null;
        throw e;
      }
    },
    async schedule(id) {
      const s = await eb.getCampaignSchedule(id);
      if (!s) return null;
      const out: RenewSchedule = {
        days: DAYS.filter((d) => s[d]),
        start: s.start_time ? String(s.start_time).slice(0, 5) : null,
        end: s.end_time ? String(s.end_time).slice(0, 5) : null,
        timezone: s.timezone ?? null,
      };
      return out;
    },
    async stepCount(id) {
      const r = await eb.getCampaignSequenceSteps(id);
      return r?.data?.sequence_steps?.length ?? 0;
    },
    async searchCampaigns(term) {
      if (!term) return [];
      return (await eb.searchCampaigns(term)).map((c) => ({ id: Number(c.id), name: String(c.name ?? ""), status: c.status ?? null }));
    },
    leadRows,
    leadCount: (id) => eb.getCampaignLeadCount(id),
    async inboxes(id) {
      const rows = await allPages((p) => eb.getCampaignSenderEmailsPage(id, p), () => eb.getCampaignSenderEmails(id));
      const seen = new Set<number>();
      return rows.filter((s) => (seen.has(Number(s.id)) ? false : (seen.add(Number(s.id)), true))).map((s): SourceInbox => ({
        id: Number(s.id),
        email: String(s.email ?? ""),
        status: s.status ?? null,
        tags: (s.tags ?? []).map((t) => (typeof t === "string" ? t : String((t as { name?: unknown }).name ?? ""))).filter(Boolean),
        dailyLimit: num(s.daily_limit),
      }));
    },
    inboxCount: (id) => eb.getCampaignSenderEmailCount(id),
    async poolInboxes() {
      // The analytics copy of every live inbox (the inbox sync keeps it; each pick is checked live before it is added).
      const out: SourceInbox[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb
          .from("sender_emails")
          .select("id, email, status, daily_limit, tags")
          .eq("team_id", teamId)
          .is("archived_at", null)
          .order("id", { ascending: true })
          .range(from, from + 999);
        if (error) throw new Error(`Inboxes: ${error.message}`);
        const rows = (data ?? []) as Array<{ id: unknown; email: unknown; status: unknown; daily_limit: unknown; tags: unknown }>;
        for (const r of rows) {
          out.push({
            id: Number(r.id),
            email: String(r.email ?? ""),
            status: r.status === null || r.status === undefined ? null : String(r.status),
            dailyLimit: num(r.daily_limit),
            tags: (Array.isArray(r.tags) ? r.tags : []).map((t) => (typeof t === "string" ? t : String((t as { name?: unknown })?.name ?? ""))).filter(Boolean),
          });
        }
        if (rows.length < 1000) return out;
      }
    },
    async liveInboxStatus(ids) {
      const out = new Map<number, string | null>();
      for (let i = 0; i < ids.length; i += PAGES_AT_ONCE) {
        await Promise.all(ids.slice(i, i + PAGES_AT_ONCE).map(async (id) => {
          try {
            const r = await eb.request<{ data?: { status?: string | null } }>(`/api/sender-emails/${id}`);
            out.set(id, r?.data?.status ?? null);
          } catch {
            out.set(id, null);
          }
        }));
      }
      return out;
    },
    async recentBounces(ids) {
      const { data, error } = await sb.rpc("analytics_os_inbox_recent_bounces", { p_team_id: teamId, p_sender_ids: ids, p_days: HEALTH_WINDOW_DAYS });
      if (error) {
        if (/analytics_os_inbox_recent_bounces|schema cache|does not exist|PGRST202/i.test(`${error.code ?? ""} ${error.message}`)) return "missing";
        throw new Error(`Recent bounces: ${error.message}`);
      }
      return ((Array.isArray(data) ? data : []) as Array<{ id: unknown; sent: unknown; bounced: unknown; sent_24h?: unknown }>).map((r): RecentBounces => ({
        id: Number(r.id), sent: Number(r.sent ?? 0), bounced: Number(r.bounced ?? 0), sent24h: Number(r.sent_24h ?? 0),
      }));
    },
    warmup: () => warmupScores(),
    links: (id) => readLinks(id, linkStore),
    async lastRenewal(sourceId) {
      const { data, error } = await sb
        .from("campaign_audit_log")
        .select("action, status, actor, created_at, batch_id, after_state")
        .eq("team_id", teamId)
        .eq("campaign_id", sourceId)
        .like("action", "duplicate-renew%")
        .order("id", { ascending: false })
        .limit(30);
      if (error) throw new Error(`Audit log: ${error.message}`);
      type Row = { action: string; status: string; actor: string; created_at: string; batch_id: string | null; after_state: Record<string, unknown> | null };
      const rows = (data ?? []) as Row[];
      if (!rows.length) return null;
      const mine = rows.filter((r) => r.batch_id === rows[0].batch_id);
      const started = mine.find((r) => r.action === "duplicate-renew-started");
      const copied = mine.find((r) => r.action === "duplicate-renew-copied");
      const finished = mine.find((r) => r.action === "duplicate-renew");
      const idOf = (r: Row | undefined) => { const n = Number(r?.after_state?.new_campaign_id); return Number.isInteger(n) && n > 0 ? n : null; };
      const out: LastRenewal = {
        at: (started ?? mine[mine.length - 1]).created_at,
        actor: (started ?? mine[0]).actor,
        finished: !!finished,
        ok: finished ? finished.status === "ok" : null,
        // A finished row says where things ended (null once the copy was deleted again); before that, the copied row.
        newCampaignId: finished ? idOf(finished) : idOf(copied),
        rolledBack: finished ? finished.after_state?.rolledBack === true : false,
      };
      return out;
    },
    async clientPin(campaignId) {
      const { data, error } = await sb
        .from("campaign_clients")
        .select("client_id, match_method")
        .eq("campaign_id", campaignId)
        .maybeSingle();
      if (error) throw new Error(`Campaign client: ${error.message}`);
      const r = data as { client_id: string | null; match_method: string | null } | null;
      // Only a pin made by hand; exclusion and name matches the sync works out for the new campaign by itself.
      if (!r || r.match_method !== "manual" || !r.client_id) return null;
      const pin: ClientPin = { clientId: r.client_id };
      return pin;
    },
    reservedInboxEmails: () => [introSenderEmail()],

    async duplicate(id) {
      const r = await eb.duplicateCampaign(id, { retry: false });
      const created = Number(r?.data?.id);
      if (!Number.isInteger(created) || created <= 0) throw new Error("EmailBison did not return the copy's id.");
      return created;
    },
    async rename(id, name) {
      await eb.updateCampaign(id, { name });
    },
    async tag(campaignId, tagIds) {
      await eb.setCampaignTags("attach", tagIds, [campaignId]);
    },
    async attachInboxes(campaignId, inboxIds) {
      try {
        await eb.attachSenderEmails(campaignId, inboxIds);
      } catch (e) {
        if (!isAllAlreadyOn(e)) throw new Error(describeEmailBisonError(e));
      }
    },
    async attachLeads(campaignId, leadIds) {
      try {
        // Every lead, even one another campaign is emailing (the user, 19 Nov: "whether they are present in any other campaign or not").
        await eb.attachLeadsToCampaign(campaignId, leadIds, { allowParallel: true });
        return "added";
      } catch (e) {
        if (isAllRefused(e)) return "refused";
        throw new Error(describeEmailBisonError(e));
      }
    },
    async moveLeads(fromId, toId, leadIds) {
      try {
        // allow_parallel_sending: without it a lead another campaign is emailing is stopped here and never added there.
        await eb.moveLeadsToCampaign(fromId, toId, leadIds, { allowParallel: true });
      } catch (e) {
        throw new Error(describeEmailBisonError(e));
      }
    },
    async stopLeads(campaignId, leadIds) {
      try {
        await eb.stopFutureEmails(campaignId, leadIds);
      } catch (e) {
        throw new Error(describeEmailBisonError(e));
      }
    },
    async deleteCampaign(id) {
      await eb.deleteCampaign(id);
    },
    moveLinks: (oldId, newId, newName, by, state) => moveLinks(oldId, newId, newName, by, state, linkStore),
    async applyClientPin(campaignId, pin, fromId) {
      // As the campaign's own Client control does (campaigns/[id]/client): a manual pin the auto-matcher never overwrites.
      const patch = { client_id: pin.clientId, match_method: "manual", matched_on: `manual pin (renewed from #${fromId})`, ambiguous: false, resolved_at: new Date().toISOString() };
      const { error, count } = await sb.from("campaign_clients").update(patch, { count: "exact" }).eq("campaign_id", campaignId);
      if (error) throw new Error(`Campaign client: ${error.message}`);
      // No row yet: the analytics sync has not listed the new campaign. Tried again later (jobs.ts).
      return (count ?? 0) > 0;
    },
    async audit(entry: RenewAudit) {
      // Every row of a renewal is filed under the OLD campaign (its history shows the whole renewal; the review reads
      // it to find a run that never finished); the new campaign's id is in after_state.
      const { error } = await sb.from("campaign_audit_log").insert({
        team_id: teamId,
        campaign_id: entry.sourceId,
        campaign_name: entry.sourceName,
        action: entry.stage === "started" ? "duplicate-renew-started" : entry.stage === "copied" ? "duplicate-renew-copied" : "duplicate-renew",
        actor: entry.actor,
        status: entry.ok ? "ok" : "error",
        error: entry.error,
        before_state: { source_campaign_id: entry.sourceId, source_name: entry.sourceName },
        after_state: { new_campaign_id: entry.newCampaignId, ...entry.detail },
        batch_id: batch,
      });
      if (error) throw new Error(`Audit log: ${error.message}`);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
