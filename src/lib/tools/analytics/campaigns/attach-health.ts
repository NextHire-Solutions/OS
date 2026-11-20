import {
  BLOCK_AT, MIN_WARMUP_SCORE, judgeInboxes,
  type InboxVerdict, type RecentBounces, type SourceInbox,
} from "./renew/inbox-health.ts";

/*
 * THE INBOX HEALTH RULES ON EVERY ATTACH (20 Nov; BrokerStaffer, Section 3: the rules Duplicate & Renew uses, on the
 * Inboxes page's "Add to campaigns" and the Campaigns page's "Assign" too). An inbox goes onto a campaign only when:
 *   - it is CONNECTED in EmailBison;
 *   - it is NOT tagged "Dead";
 *   - its bounce rate over the last 30 days is UNDER 2% (judged once it has sent 100);
 *   - its warm-up score over the last 14 days is AT LEAST 90 (judged once it has sent 20 warm-up emails).
 * The rules and their measurements live in renew/inbox-health.ts (judgeInbox); this applies them to a list of ids and
 * says what was left out and why. An inbox with too little sending to judge goes on, as in Duplicate & Renew.
 *
 * Only adding is checked: taking an inbox off a campaign never is. Instantly's pools are assigned as a live tag, not as
 * a list of inboxes, so there is nothing per inbox to check there.
 *
 * Pure: the reads are attach-health-io.ts.
 */

export type LeftOutReason = "not connected" | "Dead" | "bounce" | "warm-up" | "not found";

export interface LeftOut {
  id: number;
  email: string;
  reasons: string[];
  kinds: LeftOutReason[];
}

export interface AttachHealth {
  /** The ids that pass, in the order asked. */
  healthy: number[];
  leftOut: LeftOut[];
  /** How many were left out for each reason (an inbox with two reasons counts under both). */
  counts: Record<LeftOutReason, number>;
  /** Of the healthy ones, how many went on with too little sending or warm-up mail to judge. */
  unjudged: number;
}

export const NO_COUNTS = (): Record<LeftOutReason, number> => ({ "not connected": 0, Dead: 0, bounce: 0, "warm-up": 0, "not found": 0 });

/** Which rule a reason from judgeInbox is. */
export function kindOf(reason: string): LeftOutReason {
  if (/^Tagged "Dead"$/i.test(reason)) return "Dead";
  if (/^Bounce rate /.test(reason)) return "bounce";
  if (/^Warm-up score /.test(reason)) return "warm-up";
  return "not connected";
}

/** Every asked id gets a row (one with no recent sends has no bounce row), with its warm-up score: as Duplicate & Renew. */
export function healthRows(ids: readonly number[], bounces: readonly RecentBounces[], warmup: ReadonlyMap<number, { score: number; sent: number }>): RecentBounces[] {
  const byId = new Map(bounces.map((r) => [Number(r.id), r]));
  return ids.map((id) => {
    const b = byId.get(id);
    const w = warmup.get(id);
    return { id, sent: b?.sent ?? 0, bounced: b?.bounced ?? 0, sent24h: b?.sent24h ?? 0, warmupScore: w ? w.score : null, warmupSent: w?.sent ?? 0 };
  });
}

/**
 * Judges these ids. `inboxes` is what is known of them (status, tags); an id missing from it isn't an inbox EmailBison
 * still has, so it is left out too.
 */
export function attachHealth(ids: readonly number[], inboxes: readonly SourceInbox[], recent: readonly RecentBounces[]): AttachHealth {
  const asked = [...new Set(ids)];
  const known = new Map(inboxes.map((i) => [i.id, i]));
  const j = judgeInboxes(asked.flatMap((id) => known.get(id) ?? []), recent);
  const pass = new Set([...j.add, ...j.warn].map((v) => v.id));
  const counts = NO_COUNTS();
  const leftOut: LeftOut[] = [];
  for (const v of j.leave) {
    const kinds = [...new Set(v.reasons.map(kindOf))];
    for (const k of kinds) counts[k] += 1;
    leftOut.push({ id: v.id, email: v.email, reasons: v.reasons, kinds });
  }
  for (const id of asked) {
    if (known.has(id)) continue;
    counts["not found"] += 1;
    leftOut.push({ id, email: `#${id}`, reasons: ["Not among EmailBison's inboxes any more"], kinds: ["not found"] });
  }
  return {
    healthy: asked.filter((id) => pass.has(id)),
    leftOut,
    counts,
    unjudged: [...j.add, ...j.warn].filter((v: InboxVerdict) => v.note).length,
  };
}

const n = (k: number, one: string, many: string) => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;

/** "3 with a bounce rate of 2% or more, 1 with a warm-up score under 90, 1 tagged Dead". Empty when none. */
export function leftOutWords(counts: Record<LeftOutReason, number>): string {
  const parts: string[] = [];
  if (counts.bounce) parts.push(`${counts.bounce.toLocaleString("en-US")} with a bounce rate of ${BLOCK_AT}% or more`);
  if (counts["warm-up"]) parts.push(`${counts["warm-up"].toLocaleString("en-US")} with a warm-up score under ${MIN_WARMUP_SCORE}`);
  if (counts.Dead) parts.push(`${counts.Dead.toLocaleString("en-US")} tagged Dead`);
  if (counts["not connected"]) parts.push(`${n(counts["not connected"], "not connected", "not connected")}`);
  if (counts["not found"]) parts.push(`${counts["not found"].toLocaleString("en-US")} EmailBison no longer has`);
  return parts.join(", ");
}

/** The rule in one sentence, for the dialogs. */
export const RULE_WORDS = `Only healthy inboxes go on: connected, not tagged Dead, bounce rate under ${BLOCK_AT}% over 30 days and warm-up score ${MIN_WARMUP_SCORE} or more over 14 days. One with too little sending to judge goes on.`;

/** What the screens get: the counts and a few examples, never thousands of rows. */
export interface AttachHealthView {
  healthy: number[];
  leftOut: number;
  counts: Record<LeftOutReason, number>;
  unjudged: number;
  examples: Array<{ email: string; reasons: string[] }>;
}

export function healthView(h: AttachHealth, examples = 50): AttachHealthView {
  return {
    healthy: h.healthy,
    leftOut: h.leftOut.length,
    counts: h.counts,
    unjudged: h.unjudged,
    examples: h.leftOut.slice(0, examples).map((x) => ({ email: x.email, reasons: x.reasons })),
  };
}
