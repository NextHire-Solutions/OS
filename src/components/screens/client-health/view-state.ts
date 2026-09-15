"use client";

import { useSyncExternalStore } from "react";

import { EMPTY_FILTERS, type FilterBarState } from "./filter-bar";

/*
 * The state Client Health's three screens SHARE: which week is selected, and
 * which filters are set.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS SHARED
 *
 * In the tool all three views are one page. The week arrows sit in the header
 * and one `visible` list — filtered once — feeds the Weekly, Bi-Weekly and
 * Client Success tables alike, so stepping back a week or picking "At Risk"
 * on one view is already in force when you toggle to the next.
 *
 * The workspace splits that page into three rail destinations which are
 * mounted as siblings and stay mounted (see load.ts). Held per screen, the
 * state forked: Weekly showed last week while Bi-Weekly quietly showed this
 * one, and a plan filter set on Weekly vanished on Client Success. The same
 * module-level store the data already uses fixes both — one value, every
 * mounted screen subscribed, no provider needed in the shell this port must
 * not edit.
 */

export interface ClientHealthViewState {
  /** 0 is the current week; negative steps back. Never positive. */
  weekOffset: number;
  filters: FilterBarState;
}

const INITIAL: ClientHealthViewState = { weekOffset: 0, filters: EMPTY_FILTERS };

let state: ClientHealthViewState = INITIAL;
const listeners = new Set<() => void>();

function emit(next: ClientHealthViewState): void {
  state = next;
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

const getSnapshot = () => state;
// The server has no selection; rendering the initial value keeps hydration
// identical to the server's own render.
const getServerSnapshot = () => INITIAL;

export function useClientHealthView(): ClientHealthViewState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function setWeekOffset(update: number | ((current: number) => number)): void {
  const next = typeof update === "function" ? update(state.weekOffset) : update;
  // The tool's → button is disabled past the current week; the store enforces
  // the same ceiling so no caller can show a week that has not happened.
  emit({ ...state, weekOffset: Math.min(0, next) });
}

export function setFilters(filters: FilterBarState): void {
  emit({ ...state, filters });
}
