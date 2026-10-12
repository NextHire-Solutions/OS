"use client";

import { useEffect, useRef } from "react";

/*
 * Close a panel on a click outside it, or on Escape.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The filter box is a plain absolutely-positioned <div>, not a popover: the
 * only thing that closed it was the Filters button it was opened from. Click
 * anywhere else and it sat over the first three conversations until you went
 * back and found the button again. The Clients drawer beside a conversation
 * has the same shape and uses the same hook.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THAT IS EASY TO GET WRONG
 *
 * A menu or dialog opened from INSIDE the panel is not outside it — but it is
 * rendered in a portal on <body>, so `panel.contains(target)` says it is. The
 * filter box is made almost entirely of dropdown menus; with the naive check,
 * choosing "Label" from the field menu closed the box you were filling in.
 *
 * So while any of the UI kit's popups is open, this hook does nothing: the
 * click or the Escape belongs to that popup, which closes itself. The next one
 * closes the panel. Both listeners are on the capture phase so the popup is
 * still in the document when they ask.
 *
 * The list is the kit's popup slots by name. `[data-slot$="-content"]` would
 * be shorter and wrong — tooltips, tabs and cards are "-content" too, and a
 * tooltip showing under the cursor would make the panel undismissable.
 */
const POPUP =
  '[data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"], ' +
  '[data-slot="select-content"], [data-slot="popover-content"], ' +
  '[data-slot="dialog-content"], [data-slot="sheet-content"]';

function popupOpen(): boolean {
  return document.querySelector(POPUP) !== null;
}

/**
 * @param open      listeners are attached only while this is true
 * @param onDismiss called once per outside click or Escape
 * @param isInside  true for a node that belongs to the panel — the panel
 *                  itself and the button that toggles it
 */
export function useDismiss(
  open: boolean,
  onDismiss: () => void,
  isInside: (target: Node) => boolean,
): void {
  // The latest callbacks, so the listeners are bound once per open rather
  // than on every render of the panel's owner.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const inside = useRef(isInside);
  inside.current = isInside;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (inside.current(target) || popupOpen()) return;
      dismiss.current();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || popupOpen()) return;
      dismiss.current();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);
}
