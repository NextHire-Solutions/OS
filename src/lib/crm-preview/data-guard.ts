/*
 * Protection against bulk extraction — scrapers, crawlers, scripts — for the
 * new portal's agent-database data: Market, Prospects and Reports; and a
 * per-person cap on the assistant chat and on opening the Stripe billing page
 * (19 Oct). The user,
 * 17 Oct: "no one should be able to extract data from this new client
 * portals".
 *
 * Nothing shown on a screen can be made uncopyable by hand. What this layer
 * guarantees is that taking the data in BULK is refused by the server, and
 * noticed:
 *   - only the portal's own page may ask: a request without a browser's
 *     same-origin fetch headers is refused. This stops other sites, typed
 *     addresses, prefetches and casual scripts — but a determined script
 *     with a copied session can send the same headers (browsers forbid only
 *     PAGE scripts from setting them), so it is a first line, not the wall;
 *   - limits per person, keyed by the signed-in email — THE wall: requests a
 *     minute, and agent rows served a day;
 *   - a depth cap per search (market-model MAX_ROWS) — past it, narrow the
 *     filters;
 *   - every request is logged, every refusal logged as a warning.
 *
 * Counters live in this server's memory (one Railway instance; shared across
 * Next bundles through globalThis). The client-facing build should keep them
 * in the database and alert staff — see docs/HANDOVER.md.
 */

/** market/report: agent-database data. chat: one message to the assistant. billing: one Stripe billing page opened. */
export type GuardKind = "market" | "report" | "chat" | "billing";
export type GuardRole = "staff" | "client";

/** Per person. Staff (the preview's reviewers) can audit freely; clients get the strict limits. */
export const LIMITS: Record<GuardRole, { perMinute: number; rowsPerDay: number; reportsPerDay: number; chatsPerDay: number; billingPerDay: number }> = {
  staff: { perMinute: 120, rowsPerDay: 60_000, reportsPerDay: 500, chatsPerDay: 300, billingPerDay: 50 },
  client: { perMinute: 30, rowsPerDay: 2_000, reportsPerDay: 20, chatsPerDay: 60, billingPerDay: 10 },
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

interface Person {
  /** Request times in the last minute. */
  recent: number[];
  /** The day's window start, rows served in it, reports served in it. */
  dayStart: number;
  rows: number;
  reports: number;
  chats: number;
  billing: number;
}

const store: Map<string, Person> = ((globalThis as Record<string, unknown>).__crmPreviewGuard ??= new Map<string, Person>()) as Map<string, Person>;

function person(who: string, now: number): Person {
  let p = store.get(who);
  if (!p || now - p.dayStart >= DAY) {
    p = { recent: p?.recent ?? [], dayStart: now, rows: 0, reports: 0, chats: 0, billing: 0 };
    store.set(who, p);
  }
  p.recent = p.recent.filter((t) => now - t < MINUTE);
  return p;
}

export type Refusal = { ok: false; status: 403 | 429; message: string; reason: string };
export type Allowed = { ok: true };

/**
 * Only the page's own fetch: a browser sends Sec-Fetch-Site "same-origin" and
 * Sec-Fetch-Mode "cors" on a fetch from our page; a script, curl or a
 * cross-site page does not (and a navigation to the URL is "navigate").
 */
export function fromOwnPage(headers: { get(name: string): string | null }): boolean {
  return headers.get("sec-fetch-site") === "same-origin" && headers.get("sec-fetch-mode") === "cors";
}

/**
 * A person's own click on a link in the page — the Billing link, which opens
 * Stripe in a new tab. Same origin, a navigation, and user-activated
 * (Sec-Fetch-User), so a prefetch, a link scanner, a script or a typed URL is
 * not one.
 */
export function fromOwnClick(headers: { get(name: string): string | null }): boolean {
  return headers.get("sec-fetch-site") === "same-origin" && headers.get("sec-fetch-mode") === "navigate" && headers.get("sec-fetch-user") === "?1";
}

/** Before serving: refused if the request is not the page's own, or the person is over a limit. */
export function admit(
  who: string,
  role: GuardRole,
  kind: GuardKind,
  headers: { get(name: string): string | null },
  now = Date.now(),
): Allowed | Refusal {
  if (!(kind === "billing" ? fromOwnClick(headers) : fromOwnPage(headers))) {
    return { ok: false, status: 403, reason: "not-own-page", message: "This data is only available inside the portal." };
  }
  const limits = LIMITS[role];
  const p = person(who, now);
  if (p.recent.length >= limits.perMinute) {
    return { ok: false, status: 429, reason: "per-minute", message: "Too many requests — wait a minute and try again." };
  }
  if (kind === "market" && p.rows >= limits.rowsPerDay) {
    return { ok: false, status: 429, reason: "rows-per-day", message: "Today's limit on agents viewed is reached. It resets tomorrow." };
  }
  if (kind === "report" && p.reports >= limits.reportsPerDay) {
    return { ok: false, status: 429, reason: "reports-per-day", message: "Today's limit on reports is reached. It resets tomorrow." };
  }
  if (kind === "chat" && p.chats >= limits.chatsPerDay) {
    return { ok: false, status: 429, reason: "chats-per-day", message: "Today's limit on chat messages is reached. It resets tomorrow." };
  }
  if (kind === "billing" && p.billing >= limits.billingPerDay) {
    return { ok: false, status: 429, reason: "billing-per-day", message: "The billing page has been opened too many times today. Try again tomorrow." };
  }
  p.recent.push(now);
  return { ok: true };
}

/** After serving: count what went out. */
export function served(who: string, kind: GuardKind, rows: number, now = Date.now()): void {
  const p = person(who, now);
  if (kind === "market") p.rows += Math.max(0, rows);
  else if (kind === "report") p.reports += 1;
  else if (kind === "chat") p.chats += 1;
  else p.billing += 1;
}

/** What every data response carries: never cached anywhere, never indexed. */
export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, private, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
} as const;

/** For tests. */
export function resetGuard(): void {
  store.clear();
}
