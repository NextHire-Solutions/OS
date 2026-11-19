/*
 * DUPLICATE & RENEW — which of the old campaign's inboxes the new one gets.
 *
 * The team's rules (their "Section 3", 19 Nov) as told back to them for this
 * button: an inbox is added when it is CONNECTED in EmailBison and its bounce
 * rate over the last 30 days is under 5%. 2% or less is healthy; above 2% and
 * under 5% is a warning (added, flagged in the review window); 5% or more is
 * left out. An inbox is only judged on its bounce rate once it has sent 100
 * emails in those 30 days ("a sufficient sample size to avoid unnecessary
 * restrictions") — most inboxes send 1 to 3 a day, so below that it is added
 * and the review window says there was not enough sending to judge.
 *
 * THEN THE WIDER POOL (the team, 19 Nov): "The new campaign should prioritize
 * the healthy inboxes from the previous campaign. If additional inboxes are
 * needed, the system can select other healthy, connected inboxes from the wider
 * pool, as long as they meet our health requirements and have available
 * sending capacity." Read here as: the new campaign keeps the sending capacity
 * the old one had. The inboxes left out took their daily limits with them;
 * that much is made up from the pool (pickFromPool).
 *
 * Blocking inboxes everywhere and Slack alerts are a separate piece of work;
 * this only decides what the NEW campaign is given.
 *
 * THE RATE IS bounced ÷ (sent + bounced): a send that bounced loses its send
 * row (analytics 098 explains the measurement), so "sent" alone undercounts.
 *
 * Pure: no I/O, so every boundary is pinned by inbox-health.test.ts.
 */

export const HEALTH_WINDOW_DAYS = 30;
/** Sends (incl. bounced ones) in the window before an inbox's bounce rate is judged. */
export const MIN_SENDS = 100;
/** Above this (%) and under BLOCK_AT: a warning. */
export const WARN_ABOVE = 2;
/** At or above this (%): left out. */
export const BLOCK_AT = 5;

export interface SourceInbox {
  id: number;
  email: string;
  /** EmailBison's own status: "Connected", "Not connected", … */
  status: string | null;
  tags: string[];
  dailyLimit: number | null;
}

export interface RecentBounces {
  id: number;
  sent: number;
  bounced: number;
  /** Sends in the last 24 hours (analytics 098): what is used of its daily limit. */
  sent24h?: number;
}

export type Verdict = "add" | "warn" | "leave";

export interface InboxVerdict {
  id: number;
  email: string;
  status: string | null;
  dailyLimit: number | null;
  /** Emails sent in the window, the bounced ones included. */
  attempts: number;
  bounced: number;
  /** Percent, or null when there was too little sending to judge. */
  rate: number | null;
  verdict: Verdict;
  /** Why it is warned about or left out; empty for a plain add. */
  reasons: string[];
  /** Said about an added inbox without being a warning (e.g. too little sending to judge). */
  note: string | null;
}

export function isConnected(status: string | null | undefined): boolean {
  return String(status ?? "").trim().toLowerCase() === "connected";
}

/**
 * "3.1%" — one decimal, rounded DOWN so a 4.96% warning never reads "5.0%". A
 * warning just over 2% that one decimal would show as "2.0%" gets two ("2.05%").
 */
export function formatRate(rate: number): string {
  // + 1e-9: 2.05 * 100 is 204.999… in floating point, and must not floor to 2.04.
  const one = Math.floor(rate * 10 + 1e-9) / 10;
  if (rate > WARN_ABOVE && one <= WARN_ABOVE) return `${(Math.floor(rate * 100 + 1e-9) / 100).toFixed(2)}%`;
  return `${one.toFixed(1)}%`;
}

export function judgeInbox(inbox: SourceInbox, recent: RecentBounces | undefined): InboxVerdict {
  const sent = Math.max(0, Number(recent?.sent ?? 0));
  const bounced = Math.max(0, Number(recent?.bounced ?? 0));
  const attempts = sent + bounced;
  const rate = attempts >= MIN_SENDS ? (bounced / attempts) * 100 : null;
  const base = { id: inbox.id, email: inbox.email, status: inbox.status, dailyLimit: inbox.dailyLimit, attempts, bounced, rate };
  const window = `the last ${HEALTH_WINDOW_DAYS} days`;

  if (!isConnected(inbox.status)) {
    const said = String(inbox.status ?? "").trim();
    return { ...base, verdict: "leave", reasons: [said ? `${said} in EmailBison` : "No connection status from EmailBison"], note: null };
  }
  if (rate !== null && rate >= BLOCK_AT) {
    return { ...base, verdict: "leave", reasons: [`Bounce rate ${formatRate(rate)} over ${window} (${bounced} of ${attempts})`], note: null };
  }
  const reasons: string[] = [];
  if (rate !== null && rate > WARN_ABOVE) reasons.push(`Bounce rate ${formatRate(rate)} over ${window} (${bounced} of ${attempts}): warning`);
  if (inbox.tags.some((t) => t.trim().toLowerCase() === "dead")) reasons.push('Tagged "Dead"');
  const note = rate === null ? `Too little sending to judge its bounce rate (${attempts} in ${window})` : null;
  return { ...base, verdict: reasons.length ? "warn" : "add", reasons, note };
}

export interface InboxJudgement {
  /** Added: healthy, or too little sending to judge. */
  add: InboxVerdict[];
  /** Added, with a warning. */
  warn: InboxVerdict[];
  /** Left out, with the reason. */
  leave: InboxVerdict[];
}

export function judgeInboxes(inboxes: readonly SourceInbox[], recent: readonly RecentBounces[]): InboxJudgement {
  const byId = new Map(recent.map((r) => [Number(r.id), r]));
  const seen = new Set<number>();
  const out: InboxJudgement = { add: [], warn: [], leave: [] };
  for (const inbox of inboxes) {
    if (seen.has(inbox.id)) continue;
    seen.add(inbox.id);
    const v = judgeInbox(inbox, byId.get(inbox.id));
    out[v.verdict].push(v);
  }
  const byEmail = (a: InboxVerdict, b: InboxVerdict) => a.email.localeCompare(b.email);
  out.add.sort(byEmail);
  out.warn.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || byEmail(a, b));
  out.leave.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || byEmail(a, b));
  return out;
}

/** The inboxes the new campaign is given: the healthy ones and the warned ones. */
export function inboxesToAdd(j: InboxJudgement): number[] {
  return [...j.add, ...j.warn].map((v) => v.id);
}

/* ------------------------------------------------------------------------------------------- the wider pool --- */

/** Tags that keep an inbox out of an AUTOMATIC pick (a person can still add it by hand). */
const NOT_PICKED_TAGS = new Set(["dead", "warm up", "warmup", "warming up"]);

export interface PoolPick {
  id: number;
  email: string;
  dailyLimit: number;
  /** Its daily limit less what it sent in the last 24 hours. */
  spare: number;
  /** Percent over the window, or null when too little sending to judge. */
  rate: number | null;
  attempts: number;
  tags: string[];
  /** Shares one of the old campaign's inbox groups (a non-generic tag). */
  sameGroup: boolean;
}

export interface PoolOptions {
  /** The old campaign's inbox groups (lower-case tags, the generic ones aside): those inboxes are picked first. */
  groupTags?: ReadonlySet<string>;
  /** Addresses never picked automatically (the intro sender). Lower case. */
  reservedEmails?: ReadonlySet<string>;
}

export interface PoolPlan {
  /** Daily sending capacity the left-out inboxes had (the sum of their daily limits). */
  needed: number;
  /** What the picks add (the sum of their spare capacity). */
  added: number;
  picks: PoolPick[];
  /** needed − added when the pool could not cover it; 0 otherwise. */
  shortfall: number;
  /** Healthy, connected inboxes with capacity to spare that were not needed. */
  moreAvailable: number;
}

/** Why a pool inbox would not be picked; null when it can be. */
export function poolRefusal(inbox: SourceInbox, recent: RecentBounces | undefined, options: PoolOptions = {}): string | null {
  if (options.reservedEmails?.has(inbox.email.trim().toLowerCase())) return "reserved";
  if (!isConnected(inbox.status)) return "not connected";
  if (inbox.tags.some((t) => NOT_PICKED_TAGS.has(t.trim().toLowerCase()))) return "tagged";
  const limit = Number(inbox.dailyLimit ?? 0);
  if (!(limit > 0)) return "no daily limit";
  const sent = Math.max(0, Number(recent?.sent ?? 0));
  const bounced = Math.max(0, Number(recent?.bounced ?? 0));
  const attempts = sent + bounced;
  // Only HEALTHY ones from the pool: a warning-band inbox is kept on the old campaign's say-so, never picked fresh.
  if (attempts >= MIN_SENDS && (bounced / attempts) * 100 > WARN_ABOVE) return "bounce rate";
  if (limit - Math.max(0, Number(recent?.sent24h ?? 0)) <= 0) return "no capacity to spare";
  return null;
}

/**
 * Healthy, connected inboxes from the wider pool until their spare capacity
 * covers `needed`. Inboxes in the old campaign's own groups first (its tags,
 * e.g. "Nicole Pool"; review, 19 Nov), then the ones with the most to spare (an
 * idle inbox before one already sending for other campaigns), then
 * judged-healthy before not-yet-judged, then the lowest bounce rate. `exclude`:
 * the old campaign's own inboxes, kept or left out. "Spare" comes from synced
 * sends, so it is approximate.
 */
export function pickFromPool(
  pool: readonly SourceInbox[],
  recent: readonly RecentBounces[],
  needed: number,
  exclude: ReadonlySet<number>,
  options: PoolOptions = {},
): PoolPlan {
  const byId = new Map(recent.map((r) => [Number(r.id), r]));
  const seen = new Set<number>();
  const eligible: PoolPick[] = [];
  for (const inbox of pool) {
    if (exclude.has(inbox.id) || seen.has(inbox.id)) continue;
    seen.add(inbox.id);
    const r = byId.get(inbox.id);
    if (poolRefusal(inbox, r, options)) continue;
    const sent = Math.max(0, Number(r?.sent ?? 0));
    const bounced = Math.max(0, Number(r?.bounced ?? 0));
    const attempts = sent + bounced;
    const limit = Number(inbox.dailyLimit);
    eligible.push({
      id: inbox.id, email: inbox.email, dailyLimit: limit, spare: limit - Math.max(0, Number(r?.sent24h ?? 0)),
      rate: attempts >= MIN_SENDS ? (bounced / attempts) * 100 : null, attempts, tags: inbox.tags,
      sameGroup: inbox.tags.some((t) => options.groupTags?.has(t.trim().toLowerCase()) ?? false),
    });
  }
  eligible.sort((a, b) =>
    Number(b.sameGroup) - Number(a.sameGroup) || b.spare - a.spare || (a.rate === null ? 1 : 0) - (b.rate === null ? 1 : 0) || (a.rate ?? 0) - (b.rate ?? 0) || a.id - b.id);
  const picks: PoolPick[] = [];
  let added = 0;
  for (const e of eligible) {
    if (added >= needed) break;
    picks.push(e);
    added += e.spare;
  }
  return { needed, added, picks, shortfall: Math.max(0, needed - added), moreAvailable: eligible.length - picks.length };
}

/** The daily capacity the left-out inboxes had: what the pool is asked to make up. */
export function capacityLeftOut(j: InboxJudgement): number {
  return j.leave.reduce((sum, v) => sum + Math.max(0, Number(v.dailyLimit ?? 0)), 0);
}
