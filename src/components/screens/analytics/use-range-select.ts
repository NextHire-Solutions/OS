"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

import { applyRange, modeFor, shiftClick, type RangeMode } from "@/lib/tools/analytics/range-select.ts";

/*
 * Selecting a run of leads at once on a table's tick boxes (9 Oct).
 *
 *   - SHIFT-CLICK: tick one lead, then Shift-click another — every lead in
 *     between takes the same state.
 *   - DRAG: press on a tick box (left or right mouse button) and drag over the
 *     rows — each one passed is ticked as you go; letting go finishes it.
 *     Escape while dragging puts the selection back as it was.
 *
 * Rows are found under the pointer (`data-range-index` on each <tr>), not by
 * hover events, so fast drags and auto-scroll near the window's edge cannot
 * skip a row: the run is always everything from the start row to the current
 * one. The rules themselves are in lib/tools/analytics/range-select.ts.
 */

interface Drag<T> {
  start: number;
  last: number;
  mode: RangeMode;
  base: Set<T>;
  moved: boolean;
  button: number;
  x: number;
  y: number;
}

const EDGE = 56; // px from the top or bottom of the scroll area that starts auto-scroll
const STEP = 18; // px per tick

/** The nearest ancestor that scrolls vertically, or the page itself. */
function scrollerOf(el: HTMLElement | null): HTMLElement {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export function useRangeSelect<T>(
  ids: readonly T[],
  selected: Set<T>,
  setSelected: (next: Set<T>) => void,
  tableRef: RefObject<HTMLElement | null>,
) {
  // Latest values for the window listeners, which outlive any one render.
  const idsRef = useRef(ids);
  const selectedRef = useRef(selected);
  const setRef = useRef(setSelected);
  idsRef.current = ids;
  selectedRef.current = selected;
  setRef.current = setSelected;

  const anchor = useRef<number | null>(null);
  const drag = useRef<Drag<T> | null>(null);
  const swallowClick = useRef(false);
  const [dragging, setDragging] = useState(false);

  // A new page, sort or filter means new rows: the old anchor points at nothing.
  const idsKey = ids.map(String).join("|");
  useEffect(() => {
    anchor.current = null;
  }, [idsKey]);

  useEffect(() => {
    if (!dragging) return;
    const table = tableRef.current;
    const scroller = scrollerOf(table);

    const track = () => {
      const d = drag.current;
      if (!d) return;
      const row = document.elementFromPoint(d.x, d.y)?.closest<HTMLElement>("tr[data-range-index]");
      if (!row || !table?.contains(row)) return;
      const index = Number(row.dataset.rangeIndex);
      if (!Number.isFinite(index) || index === d.last) return;
      d.last = index;
      if (index !== d.start) d.moved = true;
      if (d.moved) setRef.current(applyRange(d.base, idsRef.current, d.start, index, d.mode));
    };

    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      drag.current.x = e.clientX;
      drag.current.y = e.clientY;
      track();
    };

    const finish = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      setDragging(false);
      if (!d.moved) return; // a plain click: the tick box's own click handles it
      anchor.current = d.last;
      // The click that follows a drag ending on its own start box would flip it back.
      swallowClick.current = true;
      setTimeout(() => (swallowClick.current = false), 0);
      if (d.button === 2) {
        // Windows opens the context menu on release, wherever the pointer is.
        const block = (ev: Event) => ev.preventDefault();
        window.addEventListener("contextmenu", block, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("contextmenu", block, { capture: true }), 400);
      }
      void e;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !drag.current) return;
      setRef.current(drag.current.base);
      drag.current = null;
      setDragging(false);
    };

    // Auto-scroll near the top or bottom edge, re-checking the row under the pointer as rows slide past it.
    const timer = window.setInterval(() => {
      const d = drag.current;
      if (!d) return;
      const box = scroller === document.scrollingElement || scroller === document.documentElement
        ? { top: 0, bottom: window.innerHeight }
        : scroller.getBoundingClientRect();
      if (d.y < box.top + EDGE) scroller.scrollBy(0, -STEP);
      else if (d.y > box.bottom - EDGE) scroller.scrollBy(0, STEP);
      else return;
      track();
    }, 30);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", finish);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragging, tableRef]);

  return {
    dragging,

    /** Spread on the element around a row's tick box: starts a drag. */
    tickZone: (index: number) => ({
      onMouseDown: (e: ReactMouseEvent) => {
        if (e.button !== 0 && e.button !== 2) return;
        // No text selection while sweeping across rows.
        e.preventDefault();
        const id = idsRef.current[index];
        drag.current = {
          start: index,
          last: index,
          mode: modeFor(selectedRef.current, id),
          base: new Set(selectedRef.current),
          moved: false,
          button: e.button,
          x: e.clientX,
          y: e.clientY,
        };
        setDragging(true);
      },
      // A right-button press on a tick box starts a drag; no browser menu there (macOS opens it on press).
      onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
    }),

    /** The tick box's click: a single toggle, or a run with Shift. */
    onTickClick: (index: number) => (e: ReactMouseEvent<HTMLInputElement>) => {
      if (swallowClick.current) {
        e.preventDefault();
        return;
      }
      const list = idsRef.current;
      const current = selectedRef.current;
      if (e.shiftKey && anchor.current !== null && anchor.current !== index && anchor.current < list.length) {
        setRef.current(shiftClick(current, list, anchor.current, index));
      } else {
        const next = new Set(current);
        const id = list[index];
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setRef.current(next);
      }
      anchor.current = index;
    },
  };
}
