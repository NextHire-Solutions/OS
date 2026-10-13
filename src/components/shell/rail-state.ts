/*
 * Whether the side menu is retracted — remembered.
 *
 * It was a bare `useState(false)` in the shell, and the shell is rebuilt on
 * navigation (the page is keyed by its address). So retracting the menu lasted
 * exactly until the next click: open a screen and it sprang back to full
 * width. That, more than anything drawn wrong, is what "when retracted, it's
 * broken" (13 Oct) was.
 *
 * Two memories, because they fail differently:
 *
 *   the cookie       read by the server, so a reload or a pasted link paints
 *                    the menu retracted from the first frame instead of
 *                    flashing it open and shut.
 *   this module      a page payload prefetched on hover BEFORE the toggle
 *                    still carries the old answer; within a tab, the last
 *                    thing the person did wins.
 *
 * No hooks and no "use client": the server reads the cookie name from here.
 */
export const RAIL_COOKIE = "os_rail";
export const RAIL_COLLAPSED = "collapsed";

let remembered: boolean | null = null;

/** What this tab last chose, or null if it has not chosen. */
export function recalledRail(): boolean | null {
  return remembered;
}

export function rememberRail(collapsed: boolean): void {
  remembered = collapsed;
  try {
    // A year, like any other layout preference. Not a secret.
    document.cookie = `${RAIL_COOKIE}=${collapsed ? RAIL_COLLAPSED : "open"}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    // Cookies blocked: the choice still holds for this tab.
  }
}

/** For tests. */
export function _forgetRail(): void {
  remembered = null;
}
