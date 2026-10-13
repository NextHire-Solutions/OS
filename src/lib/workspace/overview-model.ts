/*
 * Home's six figures and its chart — the arithmetic, with no data source
 * attached, so it is tested with the code that runs (overview-model.test.ts).
 *
 * 13 Oct, from the client's notes on Home:
 *
 *   "Remove Median Reply"
 *   "Add 2 metrics: Interested Reply (should pull from MasterInbox),
 *    Interested Reply Rate, Reply Rate per Contact (currently we have reply
 *    rate per email sent, need both)"
 *
 * So there are two reply rates, side by side and named for what they divide
 * by, because the two answer different questions and differ by a factor of
 * five or more on a sequence that emails each person several times:
 *
 *   per email sent   replies ÷ emails sent          how hard the copy works
 *   per contact      replies ÷ people emailed       how many people answer
 *
 * And Interested comes from Master Inbox — the threads people have labelled
 * Interested (or since moved on to Introduction: every introduction was
 * interested first, and the label is replaced, not added). It is NOT the
 * campaign tool's "Positive", which is a sentiment guess on EmailBison replies
 * only and reads as a dash whenever an Instantly campaign is in scope.
 *
 *   interested rate  interested ÷ replies received  of the people who
 *                                                   answered, how many want in
 */

export interface KpiWindow {
  sent: number | null;
  replies: number | null;
  /** People emailed in the window, counted once each. */
  prospects: number | null;
}

export interface OverviewMetric {
  key: string;
  label: string;
  value: number | null;
  format: "compact" | "percent" | "duration";
  /** Fractional change on the previous window. null when not computable. */
  delta: number | null;
  /** Higher is better? Drives the badge colour, not its sign. */
  higherIsBetter: boolean;
  hint?: string;
}

/** A ÷ B, or null when either is missing or B is zero — never a made-up 0%. */
export function ratio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b <= 0) return null;
  return a / b;
}

export function change(current: number | null, previous: number | null): number | null {
  // A jump from zero is infinite, not a percentage. Reporting it as one would
  // put "+Infinity%" or a nonsense figure on the card.
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}

export function homeMetrics(
  now: KpiWindow,
  before: KpiWindow | null,
  interestedNow: number | null,
  interestedBefore: number | null,
): OverviewMetric[] {
  const perEmail = ratio(now.replies, now.sent);
  const perContact = ratio(now.replies, now.prospects);
  const interestedRate = ratio(interestedNow, now.replies);
  return [
    {
      key: "sent",
      label: "Emails sent",
      value: now.sent,
      format: "compact",
      delta: change(now.sent, before?.sent ?? null),
      higherIsBetter: true,
    },
    {
      key: "replies",
      label: "Replies received",
      value: now.replies,
      format: "compact",
      delta: change(now.replies, before?.replies ?? null),
      higherIsBetter: true,
    },
    {
      key: "reply-rate",
      label: "Reply rate · per email",
      value: perEmail,
      format: "percent",
      delta: change(perEmail, before ? ratio(before.replies, before.sent) : null),
      higherIsBetter: true,
      hint: "Replies ÷ emails sent",
    },
    {
      key: "reply-rate-contact",
      label: "Reply rate · per contact",
      value: perContact,
      format: "percent",
      delta: change(perContact, before ? ratio(before.replies, before.prospects) : null),
      higherIsBetter: true,
      hint: "Replies ÷ people emailed",
    },
    {
      key: "interested",
      label: "Interested replies",
      value: interestedNow,
      format: "compact",
      delta: change(interestedNow, interestedBefore),
      higherIsBetter: true,
      hint: "Labelled Interested in Master Inbox",
    },
    {
      key: "interested-rate",
      label: "Interested reply rate",
      value: interestedRate,
      format: "percent",
      delta: change(interestedRate, before ? ratio(interestedBefore, before.replies) : null),
      higherIsBetter: true,
      hint: "Interested ÷ replies received",
    },
  ];
}

/** One day of the chart, in the shape the campaign tool's chart draws. */
export interface ChartPoint {
  date: string;
  sent: number;
  prospects: number;
  replies: number;
  human: number;
  /** On Home this slot carries Master Inbox's Interested, not Analytics' Positive. */
  positive: number;
  bounces: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/*
 * The 30-day series for the chart: Analytics' daily points, with the Positive
 * slot refilled from Master Inbox's Interested count for the same day. A day
 * Master Inbox has nothing for is 0 interested — a real zero, the label simply
 * was not applied that day — while a day Analytics does not list is not drawn.
 */
export function chartPoints(points: unknown, interestedByDay: ReadonlyMap<string, number>): ChartPoint[] {
  if (!Array.isArray(points)) return [];
  const out: ChartPoint[] = [];
  for (const raw of points) {
    const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const date = typeof row?.date === "string" ? row.date : null;
    if (!row || !date) continue;
    out.push({
      date,
      sent: n(row.sent),
      prospects: n(row.prospects),
      replies: n(row.replies),
      human: n(row.human),
      positive: interestedByDay.get(date) ?? 0,
      bounces: n(row.bounces),
    });
  }
  return out;
}

/** Sum of a day map over an inclusive ISO date window. */
export function sumWindow(byDay: ReadonlyMap<string, number>, from: string, to: string): number {
  let total = 0;
  for (const [day, count] of byDay) if (day >= from && day <= to) total += count;
  return total;
}

/*
 * Threads → a count per day.
 *
 * One per THREAD, dated by its newest Interested-or-Introduction assignment —
 * the rule Master Inbox's own feed uses (clients/intros route), so Home's
 * figure and Client Health's "Interested" are the same count of the same
 * things. `dayOf` turns the timestamp into the business's calendar day.
 */
export function threadsByDay(
  assignments: ReadonlyArray<{ target_id: string; assigned_at: string }>,
  dayOf: (iso: string) => string,
): Map<string, number> {
  const newest = new Map<string, string>();
  for (const a of assignments) {
    if (!a.target_id || !a.assigned_at) continue;
    const have = newest.get(a.target_id);
    if (!have || a.assigned_at > have) newest.set(a.target_id, a.assigned_at);
  }
  const out = new Map<string, number>();
  for (const at of newest.values()) {
    const day = dayOf(at);
    out.set(day, (out.get(day) ?? 0) + 1);
  }
  return out;
}
