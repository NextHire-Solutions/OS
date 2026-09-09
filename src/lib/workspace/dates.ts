/*
 * Timestamps that are safe to render on both sides of hydration.
 *
 * This module exists because the same bug has now shipped twice:
 *
 *   the home screen's greeting used `new Date().getHours()`, so the SERVER's
 *   clock decided it for everybody and the team read "Good evening" from 2pm;
 *
 *   the inbox's thread list used `Date.now()` and `toLocaleTimeString`, so the
 *   server rendered 01:12 UTC where the browser rendered 21:12 local — React
 *   error #418, three times in one pass over the inbox.
 *
 * Both have the same two causes and the same two rules:
 *
 *   1. NEVER read the clock while rendering. Take `now` as an argument,
 *      seeded from a value the server sent, so both sides use one instant.
 *   2. NEVER format without an explicit `timeZone`. The default is the local
 *      zone, which is UTC on the server and something else for the reader.
 *
 * Eastern is the fixed answer rather than the viewer's own zone: it must be
 * identical on both sides, and it is the timezone the business runs on —
 * Client Health dates its own days with `todayInET`.
 */

const TZ = "America/New_York";

const TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hour: "numeric", minute: "2-digit",
});
const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, month: "short", day: "numeric",
});
const FULL = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});
const HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour: "numeric",
  // h23, not `hour12: false` — that renders midnight as "24" in some ICU
  // builds, which would greet the night shift "Good evening" at 00:30.
  hourCycle: "h23",
});

/** The hour of the day in Eastern time, 0–23. */
export function hourInET(now: Date): number {
  return Number(HOUR.format(now));
}

/** A time for today, a date for anything older. `now` must come from the server. */
export function shortStamp(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return now - d.getTime() < 86_400_000 ? TIME.format(d) : DAY.format(d);
}

/** Date and time together, for a message header. */
export function fullStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : FULL.format(d);
}

/** Just the calendar day. */
export function dayStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : DAY.format(d);
}
