/*
 * One billing date, and it is Stripe's (13 Oct).
 *
 * OS feedback, marked IMPORTANT: "Wagner says Billing in 2 days, but if we
 * look on the Client, it's a different date."
 *
 * Two things were being called "the billing date":
 *
 *   the SCHEDULE   Client Health's cycle — the billing anchor date on the
 *                  record (or, with none, the start date) stepped in 14- or
 *                  28-day cycles. Delivery's "Billing in N days", the cycle's
 *                  intro target and the record's "Next billing date" all come
 *                  from it.
 *   STRIPE         when the card is actually charged.
 *
 * Nothing kept the two in step. The anchor is typed by hand; for 18 of the 22
 * clients billed through Stripe it had been set to a real charge date and the
 * two agreed to the day. Wagner had no anchor, so its cycle ran from its start
 * date (18 Aug → 13 Oct) while Stripe charges on 23 Oct. Jeff Cook and SERHANT
 * NJ were a few days out the same way.
 *
 * THE RULE. Stripe is when money moves, so where the two describe the SAME
 * cadence on different days, the schedule follows Stripe:
 *
 *   aligned   a Stripe charge date already lands on the record's cycle.
 *             Nothing changes.                                  (18 clients)
 *   follow    Stripe charges every N days, the record's cycle is N days, and
 *             the days differ. The cycle is re-anchored — IN MEMORY, nothing
 *             is written — on Stripe's next charge. The billing date, the
 *             cycle's window and its intro counts all move together, exactly
 *             as if the anchor on the record had been typed correctly.
 *   differs   the two cannot be reconciled by moving a date: Stripe charges
 *             on a different interval than the record says, or the client has
 *             several subscriptions on different days. The schedule is left
 *             alone and the difference is SAID, on both screens.
 *   none      no active Stripe subscription with an upcoming charge. The
 *             schedule on the record is all there is.
 *
 * Only a cycle counted in days is re-anchored. A monthly cycle clamps at
 * month-end (the 31st), which makes "the same cadence on another day" not a
 * simple shift; a monthly mismatch is reported, never moved.
 *
 * Pure — no dates read from the clock, no Stripe, no database.
 */

export interface StripeSubscriptionFact {
  state: "active" | "paused";
  /** The subscription's interval in days (14, 28…); null when it is month- or year-based. */
  stepDays: number | null;
  /** The next charge, as a day (YYYY-MM-DD); null when paused. */
  nextCharge: string | null;
}

export interface ScheduleOnRecord {
  billing_anchor_date: string | null;
  start_date: string | null;
  billing_interval: "biweekly" | "28-days" | "monthly" | "custom";
  billing_interval_days: number | null;
}

export type BillingAlignment =
  | { kind: "none" }
  | { kind: "aligned"; stripeNext: string }
  | {
      kind: "follow";
      /** The anchor the schedule uses instead of the record's: Stripe's next charge. */
      anchor: string;
      stripeNext: string;
      /** What the record's own dates gave, for the note. */
      recordNext: string | null;
    }
  | {
      kind: "differs";
      reason: "interval" | "several" | "monthly";
      stripeNext: string;
      stripeStep: number | null;
      recordStep: number | null;
      recordNext: string | null;
    };

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (iso: string): number => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS);
const isoOf = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
const isDay = (v: string | null | undefined): v is string => typeof v === "string" && DAY_RE.test(v.slice(0, 10)) && Number.isFinite(dayOf(v));
const mod = (n: number, m: number) => ((n % m) + m) % m;

/** The record's cycle in days: 14, 28, a custom N — or null for monthly / an unusable custom. */
export function recordStepDays(c: ScheduleOnRecord): number | null {
  if (c.billing_interval === "biweekly") return 14;
  if (c.billing_interval === "28-days") return 28;
  if (c.billing_interval === "custom") {
    const n = c.billing_interval_days;
    return n && n > 0 ? Math.floor(n) : null;
  }
  return null;
}

/** The first cycle date on or after `today` for an anchor and a step in days. */
export function nextOnCadence(anchor: string, step: number, today: string): string {
  const a = dayOf(anchor);
  const t = dayOf(today);
  if (a >= t) return isoOf(a - Math.floor((a - t) / step) * step);
  return isoOf(a + Math.ceil((t - a) / step) * step);
}

export function alignWithStripe(
  c: ScheduleOnRecord,
  subscriptions: readonly StripeSubscriptionFact[],
  today: string,
): BillingAlignment {
  const charging = subscriptions
    .filter((s) => s.state === "active" && isDay(s.nextCharge))
    .map((s) => ({ step: s.stepDays, next: s.nextCharge!.slice(0, 10) }))
    .sort((a, b) => a.next.localeCompare(b.next));
  if (!charging.length) return { kind: "none" };

  const stripeNext = charging[0].next;
  const anchor = isDay(c.billing_anchor_date) ? c.billing_anchor_date.slice(0, 10) : isDay(c.start_date) ? c.start_date.slice(0, 10) : null;
  const step = recordStepDays(c);

  if (step === null) {
    /*
     * A monthly (or unusable custom) record: never re-anchored. All that can be
     * said is whether Stripe is also month-based.
     */
    const monthBased = charging.every((s) => s.step === null);
    if (monthBased && c.billing_interval === "monthly" && anchor && Number(anchor.slice(8, 10)) === Number(stripeNext.slice(8, 10))) {
      return { kind: "aligned", stripeNext };
    }
    return { kind: "differs", reason: monthBased ? "monthly" : "interval", stripeNext, stripeStep: charging[0].step, recordStep: null, recordNext: null };
  }

  const recordNext = anchor ? nextOnCadence(anchor, step, today) : null;

  // A charge that already falls on the record's cycle: they agree.
  if (anchor) {
    const onCycle = charging.find((s) => mod(dayOf(s.next) - dayOf(anchor), step) === 0);
    if (onCycle) return { kind: "aligned", stripeNext: onCycle.next };
  }

  if (charging.some((s) => s.step !== step)) {
    const other = charging.find((s) => s.step !== step)!;
    return { kind: "differs", reason: "interval", stripeNext, stripeStep: other.step, recordStep: step, recordNext };
  }

  // Same interval throughout. One cadence only if every charge is on the same phase.
  const phase = mod(dayOf(stripeNext), step);
  if (charging.some((s) => mod(dayOf(s.next), step) !== phase)) {
    return { kind: "differs", reason: "several", stripeNext, stripeStep: step, recordStep: step, recordNext };
  }

  return { kind: "follow", anchor: stripeNext, stripeNext, recordNext };
}

/** The anchor the schedule should use in place of the record's, or null to use the record's. */
export function stripeAnchor(a: BillingAlignment | null | undefined): string | null {
  return a?.kind === "follow" ? a.anchor : null;
}

const fmt = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/*
 * What to say beside the billing date, or null when there is nothing to say
 * (the two agree, or there is no Stripe subscription to compare with).
 */
export function alignmentNote(a: BillingAlignment | null | undefined): { tone: "info" | "warn"; text: string } | null {
  if (!a || a.kind === "none" || a.kind === "aligned") return null;
  if (a.kind === "follow") {
    return {
      tone: "info",
      text: a.recordNext && a.recordNext !== a.stripeNext
        ? `Following Stripe's charge date. The dates on the client's record gave ${fmt(a.recordNext)}.`
        : "Following Stripe's charge date.",
    };
  }
  if (a.reason === "interval") {
    const stripe = a.stripeStep ? `every ${a.stripeStep} days` : "monthly";
    const record = a.recordStep ? `every ${a.recordStep} days` : "monthly";
    return { tone: "warn", text: `Stripe charges ${stripe} (next ${fmt(a.stripeNext)}), but the client's record says ${record}. The cycle shown is the record's.` };
  }
  if (a.reason === "several") {
    return { tone: "warn", text: `Stripe has subscriptions charging on different days (next ${fmt(a.stripeNext)}). The cycle shown is the record's.` };
  }
  return { tone: "warn", text: `Stripe's next charge is ${fmt(a.stripeNext)}, which is not the day on the client's record. The cycle shown is the record's.` };
}
