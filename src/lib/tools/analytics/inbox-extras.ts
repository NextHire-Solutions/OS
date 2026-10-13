/*
 * The two Inboxes columns the database cannot fill (13 Oct):
 *
 *   Warmup score, 3 days and 7 days
 *   Assigned to campaign, yes or no
 *
 * The sync stores neither. EmailBison has both, so they are read from it — in
 * the background, a few hundred requests, kept for six hours — and laid over
 * the table when they arrive. Until then (and for Instantly's inboxes, always)
 * the table shows what the database can say: a dash for the scores, and for
 * Assigned the send-history estimate inboxes.ts describes.
 *
 * Everything here is pure, with the EmailBison calls passed in, so the rules
 * are tested without a network.
 *
 * ---------------------------------------------------------------------------
 * ASSIGNED, EXACTLY — AND CHEAPLY
 *
 * "Assigned" = attached to at least one campaign that can send now (active,
 * queued or launching). EmailBison answers that two ways:
 *
 *   per campaign   its inbox list — 15 a page, 85 pages for the shared pool
 *   per inbox      the campaigns it is on — one request each
 *
 * Walking every active campaign is 24 × 85 ≈ 2,000 requests for what is, here,
 * the same 1,272 inboxes 24 times. Asking every inbox is 1,700. So: walk ONE
 * campaign (the pool nearly all of them share), which settles most inboxes as
 * Yes at once; then ask only the inboxes still unsettled, one request each.
 * If a walk leaves too many unsettled, walk another campaign first, up to a
 * small limit. On 13 Oct that is about 85 + 410 requests, not 2,000.
 */

export const SENDING_STATUSES = ["active", "queued", "launching"] as const;

export function canSend(status: string | null | undefined): boolean {
  return (SENDING_STATUSES as readonly string[]).includes((status ?? "").trim().toLowerCase());
}

/** The last `days` days ending today — inclusive, the way EmailBison's range is. */
export function warmupRange(today: string, days: number): { start: string; end: string } {
  const [y, m, d] = today.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  start.setUTCDate(start.getUTCDate() - days);
  return { start: start.toISOString().slice(0, 10), end: today };
}

/** A score as a whole number 0–100, or null when EmailBison gave none. */
export function score(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.round(n);
}

/** Runs `work` over `items`, a few at a time. Order of results follows `items`. */
export async function pooled<T, R>(items: readonly T[], size: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, run));
  return out;
}

export interface AssignedInput {
  /** Every inbox to settle. */
  inboxIds: readonly number[];
  /** Campaigns that can send now. */
  campaignIds: readonly number[];
  /** A campaign's attached inbox ids. */
  inboxesOf: (campaignId: number) => Promise<number[]>;
  /** The campaigns one inbox is on, with status. */
  campaignsOf: (inboxId: number) => Promise<Array<{ id: number; status: string | null }>>;
  /** Stop walking campaigns once this few inboxes are unsettled. */
  askBelow?: number;
  /** Never walk more campaigns than this. */
  maxWalks?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

/** The inboxes attached to at least one campaign that can send now. */
export async function resolveAssigned(input: AssignedInput): Promise<Set<number>> {
  const askBelow = input.askBelow ?? 600;
  const maxWalks = input.maxWalks ?? 4;
  const assigned = new Set<number>();
  const unsettled = new Set(input.inboxIds);
  if (!input.campaignIds.length || !unsettled.size) return assigned;

  let walks = 0;
  for (const campaignId of input.campaignIds) {
    if (walks >= maxWalks) break;
    // The first walk always happens: it is what makes the rest cheap.
    if (walks > 0 && unsettled.size <= askBelow) break;
    const before = unsettled.size;
    for (const id of await input.inboxesOf(campaignId)) {
      if (unsettled.delete(id)) assigned.add(id);
    }
    walks++;
    // A walk that settled nobody says the remaining campaigns hold other
    // inboxes or none; asking the inboxes themselves is the direct route.
    if (walks > 1 && unsettled.size === before) break;
  }

  const rest = [...unsettled];
  let done = 0;
  await pooled(rest, input.concurrency ?? 3, async (inboxId) => {
    const campaigns = await input.campaignsOf(inboxId);
    if (campaigns.some((c) => canSend(c.status))) assigned.add(inboxId);
    input.onProgress?.(++done, rest.length);
  });
  return assigned;
}

export interface InboxExtras {
  /** Inbox id → [3-day score, 7-day score]. */
  warmup: Record<string, [number | null, number | null]>;
  /** EmailBison inbox ids attached to a campaign that can send now. */
  assigned: number[];
  /** When this was read from EmailBison. */
  asOf: string;
}

interface ExtraRow {
  id: number | string;
  platform: string;
  warmup3d: number | null;
  warmup7d: number | null;
  assignedToCampaign: boolean | null;
}

/*
 * The table's rows with the extras laid over EmailBison's inboxes.
 *
 * An inbox EmailBison's warmup list does not mention keeps its dash. Assigned
 * is exact for every EmailBison inbox once the extras exist: on the list is
 * Yes, off it is No. Instantly's rows are never touched.
 */
export function withExtras<R extends ExtraRow>(rows: readonly R[], extras: InboxExtras | null): R[] {
  if (!extras) return [...rows];
  const assigned = new Set(extras.assigned.map(Number));
  return rows.map((row) => {
    if (row.platform !== "emailbison") return row;
    const scores = extras.warmup[String(row.id)];
    return {
      ...row,
      warmup3d: scores ? scores[0] : row.warmup3d,
      warmup7d: scores ? scores[1] : row.warmup7d,
      assignedToCampaign: assigned.has(Number(row.id)),
    };
  });
}

export const EXTRAS_NOTE_READY =
  "Warmup 3d / 7d and Assigned are read from EmailBison and refreshed every six hours. Warmup is EmailBison's " +
  "warmup score (0–100) over the last 3 and 7 days. Assigned is Yes when the inbox is attached to at least one " +
  "campaign that is active, queued or launching.";

export const EXTRAS_NOTE_LOADING =
  "Warmup scores and exact campaign assignment are being read from EmailBison — this takes a few minutes the " +
  "first time and fills in by itself. Until then Warmup shows a dash and Assigned is estimated from the send history.";
