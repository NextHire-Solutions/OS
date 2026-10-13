import { vendorFromTags } from "./sync/vendor.ts";

/*
 * The Inboxes page (13 Oct) — every sending inbox in one table, the way
 * Instantly lists its email accounts.
 *
 * Everything the page decides lives here rather than in the component or the
 * route: how a database row becomes a table row, what a filter matches, what
 * each filter option counts, what a column sorts by. The whole list is loaded
 * once and filtered in the browser, so there is no server to ask a second time
 * — these have to be right on their own.
 *
 * Kept free of `@/` and server-only imports on purpose — Node's native TS
 * stripping cannot resolve path aliases, and this needs to be directly
 * testable. The route and the screen both import it.
 */

export type InboxPlatform = "emailbison" | "instantly";

export const PLATFORM_LABEL: Record<InboxPlatform, string> = {
  emailbison: "EmailBison",
  instantly: "Instantly",
};

/**
 * One inbox, as the table shows it.
 *
 * NULL MEANS "NOT KNOWN", never zero and never "no". Each platform leaves
 * different things unreported, and a 0 or a "No" in those cells would be a
 * claim nobody checked.
 */
export interface InboxRow {
  /** EmailBison's inbox id; Instantly has none, so its email stands in. */
  id: number | string;
  platform: InboxPlatform;
  email: string;
  name: string | null;
  /** Google, Microsoft, Custom SMTP… — see `emailbisonType` / `instantlyType`. */
  type: string | null;
  /** Connected / Not connected / Failed, in EmailBison's own words. */
  status: string | null;
  dailyLimit: number | null;
  sentAllTime: number | null;
  /** People who replied — the same counter Infrastructure's reply rate uses. */
  repliedAllTime: number | null;
  bouncedAllTime: number | null;
  warmupEnabled: boolean | null;
  warmup3d: number | null;
  warmup7d: number | null;
  vendor: string | null;
  tags: string[];
  assignedToCampaign: boolean | null;
}

export interface InboxesResponse {
  rows: InboxRow[];
  total: number;
  /** When the list was last synced; the older platform's time when there are two. */
  asOf: string | null;
  /** What a column means, and what could not be supplied — shown under the table. */
  notes: string[];
}

/* ------------------------------------------------------ database → table row */

/** `sender_emails`, the columns this page reads. */
export interface SenderEmailRecord {
  id: number;
  email: string;
  name: string | null;
  provider: string | null;
  status: string | null;
  vendor: string | null;
  tags: string[] | null;
  daily_limit: number | null;
  warmup_enabled: boolean | null;
  lifetime_sent: number | null;
  lifetime_bounced: number | null;
  unique_replied: number | null;
  synced_at: string | null;
}

/** `instantly_accounts`, the columns this page reads. */
export interface InstantlyAccountRecord {
  email: string;
  first_name: string | null;
  last_name: string | null;
  provider_code: number | null;
  daily_limit: number | null;
  tags: string[] | null;
  synced_at: string | null;
}

/** One row of `analytics_instantly_account_rows` — the totals of what is synced. */
export interface InstantlyAccountStats {
  email: string;
  sent: number | string | null;
  bounced: number | string | null;
  replied: number | string | null;
}

/**
 * A counter as a number, or null when there is none.
 *
 * `Number(null)` is 0, which is exactly the "not known became zero" this page
 * must not show. A bigint sum can also arrive as a string.
 */
export function counter(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const tagNames = (tags: unknown): string[] =>
  Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string" && t.trim() !== "") : [];

/**
 * The connection type, in the words both platforms can share, so "Google"
 * is one filter option rather than one per platform.
 *
 * A type EmailBison adds later shows under its own name instead of vanishing
 * into "Other", where nobody would notice it.
 */
export function emailbisonType(type: string | null | undefined): string | null {
  const raw = type?.trim();
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (t.includes("google")) return "Google";
  if (t.includes("microsoft")) return "Microsoft";
  if (t === "custom") return "Custom SMTP";
  if (t === "smtp") return "SMTP";
  return raw;
}

/** Instantly's `provider_code`, as its API documents it. */
const INSTANTLY_PROVIDER: Record<number, string> = {
  1: "Custom SMTP",
  2: "Google",
  3: "Microsoft",
  4: "AWS",
  8: "AirMail",
};

export function instantlyType(code: number | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  return INSTANTLY_PROVIDER[code] ?? `Provider ${code}`;
}

/**
 * The vendor named by a list of tag NAMES — the `p.` rule in sync/vendor.ts.
 *
 * EmailBison inboxes do not need this: the sync already stores the vendor it
 * read from the full tags. It is for a list that is only names.
 */
export function vendorOf(tags: readonly string[] | null | undefined): string | null {
  return vendorFromTags((tags ?? []).map((name) => ({ id: 0, name, default: false })));
}

/**
 * @param sending the inboxes that have sent for a live campaign, or null when
 *   that could not be worked out — every row then reads "not known", not "No".
 */
export function emailbisonInbox(row: SenderEmailRecord, sending: ReadonlySet<number> | null): InboxRow {
  return {
    id: row.id,
    platform: "emailbison",
    email: row.email,
    name: row.name?.trim() || null,
    type: emailbisonType(row.provider),
    status: row.status?.trim() || null,
    dailyLimit: counter(row.daily_limit),
    sentAllTime: counter(row.lifetime_sent),
    repliedAllTime: counter(row.unique_replied),
    bouncedAllTime: counter(row.lifetime_bounced),
    warmupEnabled: typeof row.warmup_enabled === "boolean" ? row.warmup_enabled : null,
    // Not synced. See the route's notes for what would supply them.
    warmup3d: null,
    warmup7d: null,
    // The synced column, so this page and Infrastructure name the same vendor.
    vendor: row.vendor?.trim() || null,
    tags: tagNames(row.tags),
    assignedToCampaign: sending ? sending.has(row.id) : null,
  };
}

/**
 * An Instantly account as a row.
 *
 * Status and warmup stay null on purpose: Instantly reports every account as
 * "Paused" with warmup off while the workspace is demonstrably sending
 * (docs/instantly-api-findings.md), so neither field means what it says here.
 * Nothing in the database links an account to a campaign either.
 */
export function instantlyInbox(row: InstantlyAccountRecord, stats: InstantlyAccountStats | undefined): InboxRow {
  const tags = tagNames(row.tags);
  return {
    id: row.email,
    platform: "instantly",
    email: row.email,
    name: [row.first_name, row.last_name].map((p) => p?.trim()).filter(Boolean).join(" ") || null,
    type: instantlyType(row.provider_code),
    status: null,
    dailyLimit: counter(row.daily_limit),
    // No stats row is "we hold nothing for this account", not "it sent nothing".
    sentAllTime: counter(stats?.sent),
    repliedAllTime: counter(stats?.replied),
    bouncedAllTime: counter(stats?.bounced),
    warmupEnabled: null,
    warmup3d: null,
    warmup7d: null,
    vendor: vendorOf(tags),
    tags,
    assignedToCampaign: null,
  };
}

/** The most recent of a list of timestamps, or null when there is none. */
export function latestStamp(values: Iterable<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestAt = -Infinity;
  for (const v of values) {
    const at = v ? Date.parse(v) : NaN;
    if (Number.isFinite(at) && at > bestAt) {
      best = v as string;
      bestAt = at;
    }
  }
  return best;
}

/**
 * Which of these inboxes have at least one row in a table too large to read
 * whole — `campaign_lead_sends` holds every email ever sent.
 *
 * THE WALK. Ask for the newest `limit` rows belonging to a group of inboxes
 * and note who appears. Then ask again for only the inboxes that did not, and
 * so on. A page that comes back short is every row those inboxes have, so
 * whoever is still missing has none.
 *
 * Newest first is what makes it quick: every inbox that is sending today is in
 * the first page, so a group is usually settled in two or three reads rather
 * than the hundreds of pages its history runs to. It stays exact either way —
 * a full page always names at least one inbox not yet seen, because only
 * unseen inboxes were asked about.
 *
 * @param newestSenders the inbox id on each of the newest `limit` rows that
 *   belong to `ids`. One entry per ROW, so the length says whether the page
 *   was full.
 */
export async function sendersWithSends(
  ids: readonly number[],
  newestSenders: (ids: number[], limit: number) => Promise<Array<number | null>>,
  { chunk = 200, limit = 1000, parallel = 6 }: { chunk?: number; limit?: number; parallel?: number } = {},
): Promise<Set<number>> {
  const found = new Set<number>();
  const groups: number[][] = [];
  for (let i = 0; i < ids.length; i += chunk) groups.push(ids.slice(i, i + chunk));

  const walk = async (group: number[]) => {
    let remaining = group;
    while (remaining.length) {
      const page = await newestSenders(remaining, limit);
      for (const id of page) if (id !== null) found.add(id);
      if (page.length < limit) return;

      const unseen = remaining.filter((id) => !found.has(id));
      // A full page that names nobody new is not the read this walk assumes.
      // Stopping here would report "No" for everyone left, which is a guess.
      if (unseen.length === remaining.length) {
        throw new Error("the send history returned a full page naming none of the inboxes asked about");
      }
      remaining = unseen;
    }
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, groups.length) }, async () => {
      while (next < groups.length) await walk(groups[next++]);
    }),
  );
  return found;
}

/* ------------------------------------------------------------------ filters */

/** Stands in for "no value" in a filter: an untagged inbox, an unknown status. */
export const NONE = "__none__";

export const INBOX_FACETS = ["type", "status", "tags", "vendor", "assigned", "platform"] as const;
export type InboxFacet = (typeof INBOX_FACETS)[number];

/** Every filter on the page. An empty list means "not filtering on this". */
export type InboxFilters = { search: string } & Record<InboxFacet, string[]>;

export const NO_FILTERS: InboxFilters = {
  search: "",
  type: [],
  status: [],
  tags: [],
  vendor: [],
  assigned: [],
  platform: [],
};

export const FACET_LABEL: Record<InboxFacet, string> = {
  type: "Type",
  status: "Status",
  tags: "Tags",
  vendor: "Vendor",
  assigned: "Assigned to campaign",
  platform: "Platform",
};

/** What "no value" is called in each filter. */
const NONE_LABEL: Record<InboxFacet, string> = {
  type: "Unknown",
  status: "Unknown",
  tags: "No tags",
  vendor: "Untagged",
  assigned: "Unknown",
  platform: "Unknown",
};

/** Filters whose options have an order of their own; the rest go largest first. */
const FIXED_ORDER: Partial<Record<InboxFacet, readonly string[]>> = {
  assigned: ["yes", "no"],
  platform: ["emailbison", "instantly"],
};

/** The filter values one inbox answers to. Never empty — "none" is a value. */
export function facetValues(row: InboxRow, facet: InboxFacet): string[] {
  switch (facet) {
    case "type":
      return [row.type ?? NONE];
    case "status":
      return [row.status ?? NONE];
    case "tags":
      return row.tags.length ? row.tags : [NONE];
    case "vendor":
      return [row.vendor ?? NONE];
    case "assigned":
      return [row.assignedToCampaign === null ? NONE : row.assignedToCampaign ? "yes" : "no"];
    case "platform":
      return [row.platform];
  }
}

export function facetValueLabel(facet: InboxFacet, value: string): string {
  if (value === NONE) return NONE_LABEL[facet];
  if (facet === "assigned") return value === "yes" ? "Yes" : value === "no" ? "No" : value;
  if (facet === "platform") return PLATFORM_LABEL[value as InboxPlatform] ?? value;
  return value;
}

export function filtersActive(filters: InboxFilters): boolean {
  return filters.search.trim() !== "" || INBOX_FACETS.some((f) => filters[f].length > 0);
}

/**
 * The inboxes every filter agrees on.
 *
 * Within one filter the ticks are alternatives (any of these tags); across
 * filters they all have to hold. The search reads the email and the name.
 *
 * @param except leave this one filter out — how its own options are counted.
 */
export function filterInboxes(rows: InboxRow[], filters: InboxFilters, except?: InboxFacet): InboxRow[] {
  const needle = filters.search.trim().toLowerCase();
  const active = INBOX_FACETS.filter((f) => f !== except && filters[f].length > 0);
  if (!needle && !active.length) return rows;

  return rows.filter((row) => {
    if (needle && !row.email.toLowerCase().includes(needle) && !(row.name ?? "").toLowerCase().includes(needle)) {
      return false;
    }
    return active.every((f) => facetValues(row, f).some((v) => filters[f].includes(v)));
  });
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
}

/**
 * What one filter offers, with how many inboxes each option would show.
 *
 * Counted against what the OTHER filters leave, not against the whole list:
 * with a vendor chosen, "Connected 1,640" beside a table of 30 would be a
 * number about some other page.
 */
export function facetOptions(rows: InboxRow[], filters: InboxFilters, facet: InboxFacet): FacetOption[] {
  const counts = new Map<string, number>();
  for (const row of filterInboxes(rows, filters, facet)) {
    for (const v of facetValues(row, facet)) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  // A ticked option stays listed at 0, or narrowing another filter would take
  // away the only way to untick it.
  for (const v of filters[facet]) if (!counts.has(v)) counts.set(v, 0);

  const fixed = FIXED_ORDER[facet];
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: facetValueLabel(facet, value), count }))
    .sort((a, b) => {
      // "None" last, whatever its size: it is the remainder, not a choice.
      if ((a.value === NONE) !== (b.value === NONE)) return a.value === NONE ? 1 : -1;
      if (fixed) return fixed.indexOf(a.value) - fixed.indexOf(b.value);
      return b.count - a.count || a.label.localeCompare(b.label);
    });
}

/** Adds the value if it is absent, removes it if it is there. */
export function toggleValue(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** The filter chip: its name, and what is chosen once something is. */
export function facetChipLabel(facet: InboxFacet, selected: readonly string[]): string {
  const name = FACET_LABEL[facet];
  if (selected.length === 0) return name;
  if (selected.length === 1) return `${name}: ${facetValueLabel(facet, selected[0])}`;
  return `${name}: ${selected.length}`;
}

/* ------------------------------------------------------------------ columns */

export const INBOX_COLUMN_GROUPS = ["Inbox", "Sending", "Warmup"] as const;
export type InboxColumnGroup = (typeof INBOX_COLUMN_GROUPS)[number];

export interface InboxColumnDef {
  /** Also the key the column sorts by — see `inboxSortValue`. */
  key: string;
  label: string;
  group: InboxColumnGroup;
  defaultVisible: boolean;
  align?: "right";
  /** Said on hover, where the header alone would mislead. */
  hint?: string;
}

/**
 * The columns after Email, in the order the table draws them. Email is not
 * here: it is the row's identity and cannot be hidden.
 */
export const INBOX_COLUMNS: readonly InboxColumnDef[] = [
  /*
   * In the order the client listed them (13 Oct): Daily Limit, Emails Sent,
   * Replied, Bounced, Warmup Score (3 days), Warmup Score (7 days), Status,
   * Vendor, Assigned to Campaign. Tags and Type follow, off by default — they
   * were not asked for, both are filters on the page already, and with them on
   * the nine that were asked for start off-screen at a laptop's width.
   */
  { key: "dailyLimit", label: "Daily limit", group: "Sending", defaultVisible: true, align: "right" },
  { key: "sent", label: "Sent (all time)", group: "Sending", defaultVisible: true, align: "right" },
  {
    key: "replied", label: "Replied (all time)", group: "Sending", defaultVisible: true, align: "right",
    hint: "People who replied to this inbox",
  },
  { key: "bounced", label: "Bounced (all time)", group: "Sending", defaultVisible: true, align: "right" },
  {
    key: "warmup3d", label: "Warmup (3 days)", group: "Warmup", defaultVisible: true, align: "right",
    hint: "EmailBison's warmup score, 0–100, over the last 3 days",
  },
  {
    key: "warmup7d", label: "Warmup (7 days)", group: "Warmup", defaultVisible: true, align: "right",
    hint: "EmailBison's warmup score, 0–100, over the last 7 days",
  },
  // Off by default: warmup is switched on for all but a handful of inboxes.
  { key: "warmup", label: "Warmup", group: "Warmup", defaultVisible: false, hint: "Whether warmup is switched on" },
  { key: "status", label: "Status", group: "Inbox", defaultVisible: true },
  { key: "vendor", label: "Vendor", group: "Inbox", defaultVisible: true },
  {
    key: "assigned", label: "Assigned to campaign", group: "Inbox", defaultVisible: true,
    hint: "Attached to a campaign that is active, queued or launching",
  },
  // Drawn only when the list holds more than one platform.
  { key: "platform", label: "Platform", group: "Inbox", defaultVisible: true },
  { key: "tags", label: "Tags", group: "Inbox", defaultVisible: false },
  { key: "type", label: "Type", group: "Inbox", defaultVisible: false },
];

export const INBOX_DEFAULT_VISIBLE = INBOX_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key);
export const INBOX_COLUMN_PREFS_KEY = "bsa.inbox-columns.v1";
export const INBOX_COLUMN_PREFS_VERSION = 1;

/**
 * What a column sorts by. Null is "not known", which the shared sort puts
 * last whichever way the arrow points.
 */
export function inboxSortValue(row: InboxRow, key: string): string | number | null {
  switch (key) {
    case "email":
      return row.email.toLowerCase();
    case "tags":
      return row.tags.length ? row.tags.join(", ").toLowerCase() : null;
    case "type":
      return row.type;
    case "status":
      return row.status;
    case "dailyLimit":
      return row.dailyLimit;
    case "sent":
      return row.sentAllTime;
    case "replied":
      return row.repliedAllTime;
    case "bounced":
      return row.bouncedAllTime;
    case "warmup":
      return row.warmupEnabled === null ? null : row.warmupEnabled ? 1 : 0;
    case "warmup3d":
      return row.warmup3d;
    case "warmup7d":
      return row.warmup7d;
    case "vendor":
      return row.vendor;
    case "assigned":
      return row.assignedToCampaign === null ? null : row.assignedToCampaign ? 1 : 0;
    case "platform":
      return PLATFORM_LABEL[row.platform];
    default:
      return null;
  }
}

/** The badge for a connection status: green when connected, red when it failed. */
export function statusTone(status: string): "s-done" | "s-risk" | "s-pending" {
  const s = status.trim().toLowerCase();
  if (s === "connected") return "s-done";
  if (s === "failed") return "s-risk";
  return "s-pending";
}
