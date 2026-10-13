/*
 * Sending capacity, and how much of it the active campaigns need (13 Oct).
 *
 * Two questions from the client, one answer here:
 *
 *   "Sending Capacity numbers seem off, how is this calculated?"
 *   "Show Sending Capacity Needed based on the sending cap of all active
 *    campaigns."  /  "Show the volume needed to sustain the current sending
 *    limit of all Active campaigns."
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS CALCULATED
 *
 *   capacity   the daily limits of the inboxes that can send, added up.
 *              EmailBison: inboxes whose status is Connected (and not
 *              archived). Instantly: every account not archived — Instantly
 *              reports no usable connection status.
 *   unavailable  the daily limits of EmailBison inboxes that are NOT Connected.
 *              Capacity that exists on paper and cannot send today.
 *   needed     the daily send limits of the ACTIVE campaigns, added up. What
 *              the campaigns will try to send on a sending day if they have
 *              the leads. `newLeads` is the same sum for "new leads per day".
 *   gap        capacity − needed. Negative is a shortfall.
 *
 * WHY IT SEEMED OFF. The headline was EmailBison + Instantly, always. On
 * 13 Oct that was 32,600 + 11,065 = 43,665 a day — but every Instantly campaign
 * had been archived by 1 Oct. 536 Instantly inboxes with nothing to send are
 * not capacity anyone can use, and adding them made the estate look a third
 * bigger than it is. So:
 *
 *   A PLATFORM WITH NO ACTIVE CAMPAIGN IS IDLE, AND IDLE CAPACITY IS NOT
 *   COUNTED. It is still shown — named, with its figure, as "not counted" — so
 *   nothing disappears; it just is not in the total.
 *
 * Two exceptions, both so the screen never shows a made-up zero: a platform
 * the Platform filter names on its own is counted (it is what was asked for),
 * and if NO platform has an active campaign everything is counted (there is
 * no "in use" to prefer).
 *
 * Pure. The numbers come from analytics_sending_capacity and the campaigns
 * table — sending-capacity-load.ts.
 */

export type CapacityPlatform = "emailbison" | "instantly";

/** One row of `analytics_sending_capacity`. */
export interface CapacityRow {
  platform: string;
  inboxes: number | string;
  daily_capacity: number | string;
  unavailable: number | string;
}

/** An ACTIVE campaign's limits. Null where the platform does not report one. */
export interface ActiveCampaignLimit {
  platform: CapacityPlatform;
  daily: number | null;
  newLeads: number | null;
}

export interface PlatformCapacity {
  platform: string;
  inboxes: number;
  daily: number;
  unavailable: number;
  activeCampaigns: number;
  /** False = idle: shown, but left out of the total. */
  counted: boolean;
}

export interface CapacityPicture {
  platforms: PlatformCapacity[];
  /** Counted capacity a day, and the inboxes behind it. */
  daily: number;
  inboxes: number;
  unavailable: number;
  /** Idle capacity left out of `daily`. */
  idleDaily: number;
  idleInboxes: number;
  /** What the active campaigns are set to send a day, and to start a day. */
  needed: number;
  newLeads: number;
  activeCampaigns: number;
  /** Active campaigns with no daily limit on record — not in `needed`. */
  withoutLimit: number;
  /** daily − needed. Negative is a shortfall. */
  gap: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function capacityPicture(
  rows: readonly CapacityRow[],
  active: readonly ActiveCampaignLimit[],
  /** The Platform filter. Empty = every platform. */
  asked: readonly string[] = [],
): CapacityPicture {
  const inScope = (platform: string) => asked.length === 0 || asked.includes(platform);
  const campaigns = active.filter((c) => inScope(c.platform));
  const activeOn = (platform: string) => campaigns.filter((c) => c.platform === platform).length;
  const anyActive = campaigns.length > 0;

  const platforms: PlatformCapacity[] = rows
    .filter((r) => inScope(r.platform))
    .map((r) => {
      const activeCampaigns = activeOn(r.platform);
      const namedAlone = asked.length === 1 && asked[0] === r.platform;
      return {
        platform: r.platform,
        inboxes: num(r.inboxes),
        daily: num(r.daily_capacity),
        unavailable: num(r.unavailable),
        activeCampaigns,
        counted: activeCampaigns > 0 || namedAlone || !anyActive,
      };
    });

  const counted = platforms.filter((p) => p.counted);
  const idle = platforms.filter((p) => !p.counted);
  const sum = (list: PlatformCapacity[], key: "daily" | "inboxes" | "unavailable") => list.reduce((t, p) => t + p[key], 0);

  const daily = sum(counted, "daily");
  const needed = campaigns.reduce((t, c) => t + (c.daily ?? 0), 0);

  return {
    platforms,
    daily,
    inboxes: sum(counted, "inboxes"),
    unavailable: sum(counted, "unavailable"),
    idleDaily: sum(idle, "daily"),
    idleInboxes: sum(idle, "inboxes"),
    needed,
    newLeads: campaigns.reduce((t, c) => t + (c.newLeads ?? 0), 0),
    activeCampaigns: campaigns.length,
    withoutLimit: campaigns.filter((c) => c.daily == null).length,
    gap: daily - needed,
  };
}

const n = (v: number) => Math.round(v).toLocaleString("en-US");

/** "400 a day short" · "1,200 a day to spare" · "exactly enough". */
export function gapLabel(p: Pick<CapacityPicture, "gap" | "needed">): string {
  if (p.needed === 0) return "no active campaign has a daily limit";
  if (p.gap < 0) return `${n(-p.gap)} a day short`;
  if (p.gap === 0) return "exactly enough";
  return `${n(p.gap)} a day to spare`;
}

/** Needed as a share of capacity — 1.01 means the campaigns ask for 101% of it. Null with no capacity. */
export function neededShare(p: Pick<CapacityPicture, "daily" | "needed">): number | null {
  return p.daily > 0 ? p.needed / p.daily : null;
}

/** The one-line summary the Campaigns list shows above its table. */
export function capacitySentence(p: CapacityPicture): string {
  if (p.activeCampaigns === 0) return "No campaign is active, so nothing is asking for sending capacity.";
  const campaigns = `${n(p.activeCampaigns)} active campaign${p.activeCampaigns === 1 ? " is" : "s are"} set to send ${n(p.needed)} emails a day`;
  const leads = p.newLeads > 0 ? ` (${n(p.newLeads)} new leads a day)` : "";
  return `${campaigns}${leads}. Connected inboxes can send ${n(p.daily)} a day — ${gapLabel(p)}.`;
}
