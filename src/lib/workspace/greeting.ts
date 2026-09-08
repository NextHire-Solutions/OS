/*
 * The home screen's greeting.
 *
 * Extracted from the component so it can be tested across timezones without a
 * browser — this is a bug that returns quietly if nobody pins it.
 *
 * `new Date().getHours()` reads the LOCAL clock, which on the server is UTC.
 * That had two consequences, and the visible one was the worse: everybody was
 * shown the SERVER's idea of the time, so the team read "Good evening" from
 * about 2pm Eastern onward. It also produced a hydration mismatch, because the
 * browser recomputed the same expression against a different clock — React
 * threw error #418 on every load from a non-UTC timezone and silently
 * regenerated the tree.
 *
 * Eastern is the fixed answer rather than the viewer's own timezone for two
 * reasons: it must be identical on both sides of hydration, and it is the
 * timezone the business already runs on — Client Health dates its days with
 * `todayInET`.
 */

const ET_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  // h23, not `hour12: false` — that renders midnight as "24" in some ICU
  // builds, which would greet the night shift "Good evening" at 00:30.
  hourCycle: "h23",
});

/** The hour of the day in Eastern time, 0–23. */
export function hourInET(now: Date): number {
  return Number(ET_HOUR.format(now));
}

export function greeting(now: Date): string {
  const hour = hourInET(now);
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
