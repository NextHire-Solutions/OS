import { hourInET } from "./dates.ts";

/*
 * The home screen's greeting.
 *
 * `new Date().getHours()` reads the LOCAL clock, which on the server is UTC.
 * That had two consequences, and the visible one was the worse: everybody was
 * shown the SERVER's idea of the time, so the team read "Good evening" from
 * about 2pm Eastern onward. It also produced a hydration mismatch, because the
 * browser recomputed the same expression against a different clock — React
 * threw error #418 on every load from a non-UTC timezone and silently
 * regenerated the tree.
 *
 * The hour now comes from `dates.ts`, which is where every timestamp in the
 * workspace is formatted and which explains the two rules that prevent this
 * whole class of bug.
 */

export { hourInET };

export function greeting(now: Date): string {
  const hour = hourInET(now);
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
