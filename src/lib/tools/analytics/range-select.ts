/*
 * Selecting a run of rows at once (9 Oct): Shift-click, and dragging down the
 * tick boxes. Pure, so the rules are tested without a browser.
 *
 * One rule for both: the run takes the state of the row it STARTS from being
 * flipped. Start on an unticked row and the whole run is ticked; start on a
 * ticked one and the whole run is unticked. That is how Gmail and Finder
 * behave, so it is what people already expect.
 */

export type RangeMode = "select" | "deselect";

/** The rows from a to b inclusive, whichever way round. */
export function rangeIds<T>(ids: readonly T[], a: number, b: number): T[] {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(ids.length - 1, Math.max(a, b));
  return hi < lo ? [] : ids.slice(lo, hi + 1);
}

/** `base` with rows a..b ticked or unticked. Never mutates `base`. */
export function applyRange<T>(base: ReadonlySet<T>, ids: readonly T[], a: number, b: number, mode: RangeMode): Set<T> {
  const next = new Set(base);
  for (const id of rangeIds(ids, a, b)) {
    if (mode === "select") next.add(id);
    else next.delete(id);
  }
  return next;
}

/** What starting on this row does: tick the run if it is unticked, untick it if ticked. */
export function modeFor<T>(selected: ReadonlySet<T>, id: T): RangeMode {
  return selected.has(id) ? "deselect" : "select";
}

/**
 * Shift-click on row `index` after a plain click on row `anchor`: the rows
 * between them (both included) take the clicked row's new state.
 */
export function shiftClick<T>(selected: ReadonlySet<T>, ids: readonly T[], anchor: number, index: number): Set<T> {
  return applyRange(selected, ids, anchor, index, modeFor(selected, ids[index]));
}
