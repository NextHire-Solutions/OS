"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Dragging a card between the board's columns (Demo Portal, 23 Oct — the
 * client: "unable to move records"). Pointer events, not the browser's own
 * drag and drop: that never started in Chrome for the stage handles, and it
 * differs between browsers. A press that moves less than THRESHOLD is a click
 * (the card opens, as before); past it the card's name follows the pointer,
 * the column under it is marked, and letting go there moves the agent — the
 * same save as the list's "Move to…". Near the board's left or right edge,
 * or the window's top or bottom, it scrolls.
 */

const THRESHOLD = 6;
const EDGE = 64;
const SPEED = 14;

export interface BoardDrag {
  id: string;
  name: string;
  /** The column the card was picked up from. */
  from: string;
  x: number;
  y: number;
  /** The column under the pointer, if any. */
  over: string | null;
}

const columnAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-col]")?.dataset.col ?? null;

export function useBoardDrag(live: boolean, onDrop: (id: string, to: string) => void) {
  const [drag, setDrag] = useState<BoardDrag | null>(null);
  const press = useRef<{ id: string; name: string; from: string; x: number; y: number; pointerId: number; started: boolean } | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const suppress = useRef(false);
  const dropRef = useRef(onDrop);
  useEffect(() => { dropRef.current = onDrop; });
  const dragging = drag !== null;

  // While a card is held: scroll near the edges, and keep the column under the pointer current as the board moves.
  useEffect(() => {
    if (!dragging) return;
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    let raf = 0;
    const tick = () => {
      const p = last.current;
      if (p) {
        let moved = false;
        const board = document.querySelector<HTMLElement>("[data-board]");
        if (board) {
          const r = board.getBoundingClientRect();
          if (p.x < r.left + EDGE && board.scrollLeft > 0) { board.scrollLeft -= SPEED; moved = true; }
          else if (p.x > r.right - EDGE && board.scrollLeft + board.clientWidth < board.scrollWidth) { board.scrollLeft += SPEED; moved = true; }
        }
        if (p.y < EDGE && window.scrollY > 0) { window.scrollBy(0, -SPEED); moved = true; }
        else if (p.y > window.innerHeight - EDGE) { window.scrollBy(0, SPEED); moved = true; }
        if (moved) {
          const over = columnAt(p.x, p.y);
          setDrag((d) => (d && d.over !== over ? { ...d, over } : d));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging]);

  /** Spread on a card. */
  const cardProps = (id: string, name: string, from: string) => ({
    "data-card": id,
    onPointerDown: (e: React.PointerEvent) => {
      if (!live || e.button !== 0 || !e.isPrimary) return;
      press.current = { id, name, from, x: e.clientX, y: e.clientY, pointerId: e.pointerId, started: false };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        press.current = null;
        last.current = null;
        setDrag(null);
      };
      const move = (ev: PointerEvent) => {
        const p = press.current;
        if (!p || ev.pointerId !== p.pointerId) return;
        if (!p.started) {
          if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < THRESHOLD) return;
          p.started = true;
        }
        ev.preventDefault();
        last.current = { x: ev.clientX, y: ev.clientY };
        setDrag({ id: p.id, name: p.name, from: p.from, x: ev.clientX, y: ev.clientY, over: columnAt(ev.clientX, ev.clientY) });
      };
      const up = (ev: PointerEvent) => {
        const p = press.current;
        if (!p || ev.pointerId !== p.pointerId) return;
        const started = p.started;
        end();
        if (!started) return;
        // The click that follows letting go must not open the card.
        suppress.current = true;
        setTimeout(() => { suppress.current = false; }, 0);
        const to = columnAt(ev.clientX, ev.clientY);
        if (to && to !== p.from) dropRef.current(p.id, to);
      };
      const cancel = (ev: PointerEvent) => { if (press.current && ev.pointerId === press.current.pointerId) end(); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
  });

  /** True for the click that ends a drag — the card's onClick ignores it. */
  const wasDrag = () => suppress.current;

  return { drag, cardProps, wasDrag };
}
