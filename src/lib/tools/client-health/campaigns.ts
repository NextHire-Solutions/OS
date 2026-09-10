import type {
  BisonCampaign,
  CampaignSource,
  DashboardClient,
  InstantlyCampaign,
} from "./types.ts";

/*
 * Campaign arithmetic — for the Campaign Progress cell and the campaigns popup.
 *
 * Ported from the tool's `ClientRow` and `CampaignsPopup` so the numbers are
 * the tool's rather than a second interpretation of them. Pure and out of the
 * components so it is testable without a browser, which matters here because
 * two of these are easy to get subtly wrong:
 *
 *   the roll-up percentage is WEIGHTED — sum of completed over sum of leads,
 *   not the mean of the per-campaign rates. The mean would let a 40-lead
 *   campaign at 100% cancel out a 4,000-lead campaign at 10%.
 *
 *   only RUNNING campaigns count. The tool's spec is explicit: the count, the
 *   dropdown and the roll-up all exclude paused and finished campaigns, so a
 *   client who stopped a campaign last month does not still read as busy.
 */

/** A campaign from either source, annotated so a merged list can be keyed. */
export interface PopupCampaign {
  id: string;
  name: string;
  status: "running" | "paused" | "finished" | null;
  emails_sent_total: number;
  campaign_size: number;
  progress_pct: number;
  status_changed_at?: string | null;
  source: CampaignSource;
  reply_count: number;
  interested_count: number;
}

export type AnyCampaign = InstantlyCampaign | BisonCampaign;

/** The running campaigns across both sources, Instantly first. */
export function activeCampaigns(c: DashboardClient): AnyCampaign[] {
  return [
    ...c.campaigns.filter((x) => x.status === "running"),
    ...c.bisonCampaigns.filter((x) => x.status === "running"),
  ];
}

/** True when any campaign was ever launched — the "Campaign Paused" test. */
export function hasLaunched(c: DashboardClient): boolean {
  return [...c.campaigns, ...c.bisonCampaigns].some(
    (x) => x.status === "paused" || x.status === "finished",
  );
}

/**
 * The label under a client's name.
 *
 * The distinction the tool draws, and the reason this is not just a count: a
 * client with no running campaign has either stopped one or never started one,
 * and those need different conversations.
 */
export function campaignsLabel(c: DashboardClient): string {
  const n = activeCampaigns(c).length;
  if (n === 1) return "1 active campaign";
  if (n > 1) return `${n} active campaigns`;
  return hasLaunched(c) ? "Campaign Paused" : "Not Active";
}

export interface CampaignProgress {
  /** Emails sent — the selected campaign's, or the sum across all running. */
  sent: number;
  totalLeads: number;
  completedLeads: number;
  /** Weighted across campaigns. See the note at the top of this file. */
  pct: number;
}

/**
 * The Campaign Progress cell.
 *
 * `selectedId` picks one running campaign; anything else (including the
 * tool's `__avg__` sentinel and an id that has since stopped running) rolls
 * every running campaign up.
 *
 * Completed leads are back-computed from the stored percentage rather than
 * stored directly — that is what the tool does, and the two-decimal precision
 * in the column keeps it exact.
 */
export function campaignProgress(
  campaigns: AnyCampaign[],
  selectedId?: string | null,
): CampaignProgress {
  const selected = campaigns.find((c) => c.id === selectedId) ?? null;

  if (selected) {
    const completed = Math.round(selected.campaign_size * (selected.progress_pct / 100));
    return {
      sent: selected.emails_sent_total,
      totalLeads: selected.campaign_size,
      completedLeads: completed,
      pct: selected.progress_pct,
    };
  }

  const sent = campaigns.reduce((a, b) => a + b.emails_sent_total, 0);
  const totalLeads = campaigns.reduce((a, b) => a + b.campaign_size, 0);
  const completedLeads = campaigns.reduce(
    (a, b) => a + Math.round(b.campaign_size * (b.progress_pct / 100)),
    0,
  );
  return {
    sent,
    totalLeads,
    completedLeads,
    pct: totalLeads > 0 ? (completedLeads / totalLeads) * 100 : 0,
  };
}

/** Running first, then paused, then finished, then draft. */
const statusRank = (s: PopupCampaign["status"]): number =>
  s === "running" ? 0 : s === "paused" ? 1 : s === "finished" ? 2 : 3;

function sortGroup(group: PopupCampaign[]): PopupCampaign[] {
  return [...group].sort((a, b) => {
    const r = statusRank(a.status) - statusRank(b.status);
    if (r !== 0) return r;
    // Then most recently changed first, so what just stopped is near the top.
    const at = a.status_changed_at ? Date.parse(a.status_changed_at) : 0;
    const bt = b.status_changed_at ? Date.parse(b.status_changed_at) : 0;
    return bt - at;
  });
}

export interface CampaignGroups {
  instantly: PopupCampaign[];
  bison: PopupCampaign[];
  all: PopupCampaign[];
  running: PopupCampaign[];
  /** Emails sent across the RUNNING campaigns — the popup's header figure. */
  totalSent: number;
  /**
   * Whether to draw the "Instantly" / "Bison" headings.
   *
   * Only when both sources have campaigns. With one source the headings label
   * a list that could not be anything else, which is noise.
   */
  showHeaders: boolean;
}

/** Every linked campaign, grouped by vendor and sorted within each group. */
export function campaignGroups(c: DashboardClient): CampaignGroups {
  const instantly = sortGroup(c.campaigns.map((x) => ({ ...x, source: "instantly" as const })));
  const bison = sortGroup(c.bisonCampaigns.map((x) => ({ ...x, source: "bison" as const })));
  const all = [...instantly, ...bison];
  const running = all.filter((x) => x.status === "running");
  return {
    instantly,
    bison,
    all,
    running,
    totalSent: running.reduce((a, b) => a + b.emails_sent_total, 0),
    showHeaders: instantly.length > 0 && bison.length > 0,
  };
}

export interface CampaignDetail {
  /** Clamped to 0–100; a vendor occasionally reports over. */
  pct: number;
  completed: number;
  total: number;
  sent: number;
  label: "Running" | "Campaign Paused" | "Finished" | "Draft";
  /** Reply rate, or null when nothing has been sent. */
  replyPct: number | null;
  /** Interested as a share of replies, or null when there are no replies. */
  positivePct: number | null;
  replies: number;
  interested: number;
}

/** One row of the campaigns popup. */
export function campaignDetail(c: PopupCampaign): CampaignDetail {
  const pct = Math.min(100, Math.max(0, Number(c.progress_pct ?? 0)));
  const total = c.campaign_size ?? 0;
  const sent = c.emails_sent_total ?? 0;
  const replies = c.reply_count ?? 0;
  const interested = c.interested_count ?? 0;
  return {
    pct,
    completed: Math.round(total * (pct / 100)),
    total,
    sent,
    label:
      c.status === "running" ? "Running"
      : c.status === "paused" ? "Campaign Paused"
      : c.status === "finished" ? "Finished"
      : "Draft",
    replyPct: sent > 0 ? (replies / sent) * 100 : null,
    positivePct: replies > 0 ? (interested / replies) * 100 : null,
    replies,
    interested,
  };
}

/*
 * One client's funnel, summed over the loaded weeks.
 *
 * NOT the all-time counters `summarize()` uses. That is deliberate and it
 * matches the tool: migration 0016 added `total_*_corofy` for the headline
 * Lifetime cards only, and the tool's row cells and its Interested / Converted
 * / Int → Intro column sorts all still sum `metricsByWeek`. Switching the
 * cells over would make a column disagree with the sort that orders it.
 */
export function clientFunnel(c: DashboardClient): {
  interested: number;
  converted: number;
  ratePct: number | null;
} {
  let interested = 0;
  let converted = 0;
  for (const m of Object.values(c.metricsByWeek)) {
    interested += m.interested_corofy ?? 0;
    converted += m.intros_corofy ?? 0;
  }
  const funnel = interested + converted;
  return { interested, converted, ratePct: funnel > 0 ? (converted / funnel) * 100 : null };
}
