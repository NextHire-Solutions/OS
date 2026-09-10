import { derive, type DerivedRow } from "./derive.ts";
import type { DashboardClient } from "./types.ts";

/*
 * The Weekly summary — the tool's counter loop, ported.
 *
 * Deliberately pure and free of `server-only` so the SAME function runs on the
 * server for first paint and in the browser when the reader changes week. Two
 * implementations of this arithmetic would eventually disagree, and the way
 * you would find out is a headline number that changes when you click "←" and
 * then "→" back again.
 *
 * Two subtleties are easy to get wrong and are reproduced deliberately:
 *
 *   hidden clients are skipped entirely — off-roster, counted nowhere
 *   client_paused clients are skipped too, but counted on their own card
 *
 * Get that wrong and every headline number is inflated by twelve clients.
 */

export interface WeeklyRow {
  client: DashboardClient;
  derived: DerivedRow;
}

/*
 * One funnel, in raw counts.
 *
 * The tool shows the same four-stage funnel twice — once over all time and
 * once over the visible week — so the shape is named once and the rates are
 * computed from it rather than carried alongside. Storing formatted
 * percentages would put "1.3%" and its own numerator in two places, and the
 * two would eventually disagree.
 */
export interface FunnelTotals {
  /** Emails sent. Lifetime: summed across campaigns. Week: weekly_metrics. */
  emails: number;
  /** Unique replies. Lifetime: campaign caches. Week: Instantly + Bison. */
  replies: number;
  /** Corofy "Interested" — leads still in the pipeline. */
  interested: number;
  /** Corofy "Introduction" — leads that converted out of Interested. */
  converted: number;
}

export interface FunnelRates {
  /** Replies as a share of emails sent. */
  replyRate: number | null;
  /** Interested as a share of replies — how many replies were good ones. */
  positiveReply: number | null;
  /** Introductions per 1,000 emails. The tool displays this with a % sign. */
  convPer1k: number | null;
  /** Converted as a share of the whole funnel. */
  intToIntro: number | null;
}

const EMPTY_FUNNEL: FunnelTotals = { emails: 0, replies: 0, interested: 0, converted: 0 };

/**
 * The four rates the funnel cards show.
 *
 * Every one is null rather than zero when its denominator is zero. "No emails
 * have been sent" and "emails were sent and nobody replied" are opposite
 * situations, and a 0.0% that means the first is a lie the reader will act on.
 */
export function funnelRates(f: FunnelTotals): FunnelRates {
  const funnel = f.converted + f.interested;
  return {
    replyRate: f.emails > 0 ? (f.replies / f.emails) * 100 : null,
    positiveReply: f.replies > 0 ? (f.interested / f.replies) * 100 : null,
    convPer1k: f.emails > 0 ? (f.converted / f.emails) * 1000 : null,
    intToIntro: funnel > 0 ? (f.converted / funnel) * 100 : null,
  };
}

export interface WeeklySummary {
  total: number;
  risk: number;
  ok: number;
  done: number;
  intros: number;
  target: number;
  emails: number;
  clientPaused: number;
  plans: { minimum: number; production: number; partner: number };
  completionPct: number;

  /** Introductions so far in each client's current monthly cycle, summed. */
  monthlyIntros: number;
  /** The sum of every client's `monthly_target`. Clients at 0 contribute 0. */
  monthlyTarget: number;
  monthlyCompletionPct: number;

  /** All-time funnel. See `allTimeCorofy` for where each figure comes from. */
  lifetime: FunnelTotals;
  /** The visible week's funnel, entirely from `weekly_metrics`. */
  week: FunnelTotals;

  /** Introductions per 1,000 emails, across clients that sent anything. */
  avgConv: number | null;
  convertedTotal: number;
  interestedTotal: number;
  /** Converted as a share of the whole funnel. Null when the funnel is empty. */
  intToIntroPct: number | null;
}

/** Derives every client for one week. */
export function deriveRows(clients: DashboardClient[], key: string): WeeklyRow[] {
  return clients.map((client) => ({ client, derived: derive(client, key) }));
}

/*
 * One client's all-time Corofy counts.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COUNTERS ARE PREFERRED OVER SUMMING THE WEEKS
 *
 * `metricsByWeek` only holds the last 26 weeks — that is the window
 * `loadDashboard` fetches. Summing it therefore answers "since March", not
 * "all time", and for a client onboarded two years ago those are very
 * different numbers. The tool added `total_intros_corofy` and
 * `total_interested_corofy` (migration 0016) precisely so the Lifetime funnel
 * stops being clipped to that window.
 *
 * The fallback matters for exactly one situation: a client the sync worker has
 * not touched since the migration, whose counters are still 0. Summing the
 * weeks is wrong for them too, but it is the tool's own choice and it is
 * closer than showing nothing. It drops out on the next sync tick.
 */
export function allTimeCorofy(c: DashboardClient): { converted: number; interested: number } {
  const converted = c.total_intros_corofy ?? 0;
  const interested = c.total_interested_corofy ?? 0;
  if (converted > 0 || interested > 0) return { converted, interested };

  let weekConverted = 0;
  let weekInterested = 0;
  for (const m of Object.values(c.metricsByWeek)) {
    weekConverted += m.intros_corofy ?? 0;
    weekInterested += m.interested_corofy ?? 0;
  }
  return { converted: weekConverted, interested: weekInterested };
}

/**
 * The headline numbers for one week.
 *
 * `key` is the week on screen. It is a parameter rather than something read
 * off the rows because the This Week funnel needs a whole `weekly_metrics`
 * row — replies in particular are not part of `derive()`'s output — and
 * guessing the week from the rows would be guessing.
 */
export function summarize(rows: WeeklyRow[], key: string): WeeklySummary {
  let total = 0, risk = 0, ok = 0, done = 0;
  let intros = 0, emails = 0, target = 0, clientPaused = 0;
  let convNum = 0, convDen = 0;
  let monthlyIntros = 0, monthlyTarget = 0;
  const plans = { minimum: 0, production: 0, partner: 0 };

  const lifetime: FunnelTotals = { ...EMPTY_FUNNEL };
  const week: FunnelTotals = { ...EMPTY_FUNNEL };

  for (const { client, derived } of rows) {
    if (client.hidden) continue;
    if (client.client_paused) {
      clientPaused++;
      continue;
    }
    total++;
    target += client.weekly_target;
    if (client.plan in plans) plans[client.plan as keyof typeof plans]++;
    if (derived.status === "risk") risk++;
    if (derived.status === "ok") ok++;
    if (derived.metTarget) done++;
    intros += derived.intros;
    emails += derived.emails;
    if (derived.emails > 0) {
      convNum += derived.intros;
      convDen += derived.emails;
    }

    const allTime = allTimeCorofy(client);
    lifetime.converted += allTime.converted;
    lifetime.interested += allTime.interested;

    /*
     * Lifetime emails and replies come from the CAMPAIGN caches, not from the
     * weekly rows — those are also clipped to 26 weeks, and a lifetime reply
     * rate computed over a quarter of the emails is not a lifetime reply rate.
     */
    for (const camp of [...client.campaigns, ...client.bisonCampaigns]) {
      lifetime.emails += camp.emails_sent_total ?? 0;
      lifetime.replies += camp.reply_count ?? 0;
    }

    // The visible week's funnel, all four stages from one weekly_metrics row.
    const m = client.metricsByWeek[key];
    if (m) {
      week.emails += m.emails_sent ?? 0;
      week.replies += m.replies ?? 0;
      week.converted += m.intros_corofy ?? 0;
      week.interested += m.interested_corofy ?? 0;
    }

    monthlyIntros += client.intros_this_month ?? 0;
    monthlyTarget += client.monthly_target ?? 0;
  }

  const totalFunnel = lifetime.converted + lifetime.interested;

  return {
    total, risk, ok, done, intros, target, emails, clientPaused, plans,
    completionPct: target > 0 ? Math.round((intros / target) * 100) : 0,
    monthlyIntros,
    monthlyTarget,
    monthlyCompletionPct: monthlyTarget > 0 ? Math.round((monthlyIntros / monthlyTarget) * 100) : 0,
    lifetime,
    week,
    // A rate with no denominator is unknown, not zero.
    avgConv: convDen > 0 ? (convNum / convDen) * 1000 : null,
    convertedTotal: lifetime.converted,
    interestedTotal: lifetime.interested,
    intToIntroPct: totalFunnel > 0 ? (lifetime.converted / totalFunnel) * 100 : null,
  };
}
