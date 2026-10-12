import { useSyncExternalStore } from "react";

import { CLIENTS_PANEL_COOKIE, CLIENTS_PANEL_HIDDEN } from "./clients-panel-cookie";

/*
 * Whether the Clients panel is showing beside an open conversation.
 *
 * ---------------------------------------------------------------------------
 * TWO COMPONENTS, ONE ANSWER
 *
 * The button that toggles the panel sits in the filter bar; the panel sits in
 * the split below it. They are siblings three levels apart inside a server
 * component, so there is no parent to hold the state — hence a module store
 * read through `useSyncExternalStore`, which is the smallest thing that keeps
 * the two in step.
 *
 * ---------------------------------------------------------------------------
 * TWO STATES, BECAUSE THERE ARE TWO LAYOUTS
 *
 * mi-inbox.css decides, from the width of the stage, whether the panel is a
 * COLUMN or a DRAWER:
 *
 *   collapsed   the column is hidden. A preference — remembered in a cookie,
 *               so the server draws it right on the first paint.
 *   drawer      the drawer is open. Momentary — never stored, and closed again
 *               by a click outside, Escape, or leaving the screen. A drawer
 *               that reopened itself on every conversation would be a bug.
 *
 * `collapsed` starts as null, meaning "nobody has pressed the button in this
 * tab yet": until then the answer is the one the server read from the cookie.
 */

interface PanelState {
  collapsed: boolean | null;
  drawer: boolean;
}

const INITIAL: PanelState = { collapsed: null, drawer: false };
let state: PanelState = INITIAL;
const listeners = new Set<() => void>();

function set(next: PanelState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useClientsPanel(initialCollapsed: boolean): { collapsed: boolean; drawer: boolean } {
  const s = useSyncExternalStore(subscribe, () => state, () => INITIAL);
  return { collapsed: s.collapsed ?? initialCollapsed, drawer: s.drawer };
}

export function closeClientsDrawer(): void {
  if (state.drawer) set({ ...state, drawer: false });
}

/*
 * Which layout the stylesheet resolved. Read from the custom property the
 * container query sets on the panel, so the script and the CSS cannot disagree
 * about where the breakpoint is — and nothing has to be measured or observed.
 * (A custom property still resolves on an element that is `display: none`.)
 */
function mode(): "column" | "drawer" {
  const panel = document.querySelector<HTMLElement>(".mi-split-conv > .mi-lists");
  if (!panel) return "column";
  return getComputedStyle(panel).getPropertyValue("--mi-lists-mode").trim() === "drawer" ? "drawer" : "column";
}

/** True when the panel is on screen right now, in whichever layout applies. */
export function clientsPanelShowing(initialCollapsed: boolean): boolean {
  return mode() === "drawer" ? state.drawer : !(state.collapsed ?? initialCollapsed);
}

export function toggleClientsPanel(initialCollapsed: boolean): void {
  if (mode() === "drawer") {
    set({ ...state, drawer: !state.drawer });
    return;
  }
  const collapsed = !(state.collapsed ?? initialCollapsed);
  try {
    // A year, like any other layout preference. Not a secret and not read by
    // anything but thread-detail.tsx.
    document.cookie =
      `${CLIENTS_PANEL_COOKIE}=${collapsed ? CLIENTS_PANEL_HIDDEN : "shown"}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    // Cookies blocked: the choice still holds for this tab.
  }
  set({ collapsed, drawer: false });
}
