"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Dragging a column of the board to reorder the pipeline's stages (Demo
 * Portal, 27 Oct — the client, once cards could be moved: "stages cannot be
 * moved at this time in the demo portal"). The same rules as dragging a card
 * (board-drag.tsx): pointer events, not the browser's drag and drop; a mouse
 * or pen picks a column up by its heading once it has moved THRESHOLD; a
 * finger presses and HOLDS (a swipe still scrolls the board). The columns
 * reorder live under the pointer, the board scrolls near its edges, and
 * letting go saves the new order — the same save as Manage stages. The
 * heading's grip also moves its column one place with the arrow keys.
 */

const THRESHOLD = 6;
const HOLD_MS = 280;
const TOUCH_SLOP = 10;
const EDGE = 64;
const SPEED = 14;

const columnAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-col]")?.dataset.col ?? null;

/** `keys`: the columns as saved, in order. `onDrop`: the new order, when it changed. */
export function useColumnDrag(live: boolean, keys: readonly string[], onDrop: (order: string[]) => void) {
  // The order shown while a column is held, and after letting go until the saved order comes back.
  const [order, setOrder] = useState<string[] | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const press = useRef<{ key: string; x: number; y: number; pointerId: number; started: boolean; touch: boolean; timer: number } | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const orderRef = useRef<string[]>([...keys]);
  const dropRef = useRef(onDrop);
  useEffect(() => { dropRef.current = onDrop; });
  const sig = keys.join("|");
  // The saved order changed (a save landed, or the page reloaded): show it, unless a column is in hand.
  useEffect(() => {
    if (press.current?.started) return;
    orderRef.current = [...keys];
    setOrder(null);
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  // A held column keeps the page still under the finger; a long press shows no menu.
  useEffect(() => {
    if (!live) return;
    const still = (e: TouchEvent) => { if (press.current?.started && e.cancelable) e.preventDefault(); };
    const noMenu = (e: Event) => { if (press.current?.touch) e.preventDefault(); };
    window.addEventListener("touchmove", still, { passive: false });
    window.addEventListener("contextmenu", noMenu);
    return () => {
      window.removeEventListener("touchmove", still);
      window.removeEventListener("contextmenu", noMenu);
    };
  }, [live]);

  /** The held column takes the place of the column under the pointer. */
  const follow = (x: number, y: number) => {
    const p = press.current;
    if (!p) return;
    const over = columnAt(x, y);
    if (!over || over === p.key) return;
    const cur = orderRef.current;
    const from = cur.indexOf(p.key);
    const to = cur.indexOf(over);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...cur];
    next.splice(from, 1);
    next.splice(to, 0, p.key);
    orderRef.current = next;
    setOrder(next);
  };

  // While a column is held: scroll near the board's edges, and keep the order current as it moves.
  useEffect(() => {
    if (!held) return;
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const board = document.querySelector<HTMLElement>("[data-board]");
    const prevSnap = board?.style.scrollSnapType ?? "";
    if (board) board.style.scrollSnapType = "none";
    let raf = 0;
    const tick = () => {
      const p = last.current;
      if (p && board) {
        const r = board.getBoundingClientRect();
        let moved = false;
        if (p.x < r.left + EDGE && board.scrollLeft > 0) { board.scrollLeft -= SPEED; moved = true; }
        else if (p.x > r.right - EDGE && board.scrollLeft + board.clientWidth < board.scrollWidth) { board.scrollLeft += SPEED; moved = true; }
        if (moved) follow(p.x, p.y);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.userSelect = prevSelect;
      if (board) board.style.scrollSnapType = prevSnap;
    };
  }, [held]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = (next: readonly string[]) => next.join("|") !== keys.join("|");

  /** Spread on a column's heading. */
  const headProps = (key: string) => ({
    "data-colh": key,
    onPointerDown: (e: React.PointerEvent) => {
      if (!live || e.button !== 0 || !e.isPrimary) return;
      const touch = e.pointerType === "touch";
      const begin = () => {
        const p = press.current;
        if (!p) return;
        p.started = true;
        orderRef.current = order ?? [...keys];
        setHeld(p.key);
      };
      press.current = { key, x: e.clientX, y: e.clientY, pointerId: e.pointerId, started: false, touch, timer: 0 };
      last.current = { x: e.clientX, y: e.clientY };
      if (touch) {
        const p = press.current;
        p.timer = window.setTimeout(() => {
          if (press.current !== p) return;
          begin();
          navigator.vibrate?.(10);
        }, HOLD_MS);
      }
      const end = () => {
        if (press.current) window.clearTimeout(press.current.timer);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        press.current = null;
        last.current = null;
        setHeld(null);
      };
      const move = (ev: PointerEvent) => {
        const p = press.current;
        if (!p || ev.pointerId !== p.pointerId) return;
        if (!p.started) {
          const far = Math.hypot(ev.clientX - p.x, ev.clientY - p.y);
          if (p.touch) {
            if (far > TOUCH_SLOP) end();
            else last.current = { x: ev.clientX, y: ev.clientY };
            return;
          }
          if (far < THRESHOLD) return;
          begin();
        }
        ev.preventDefault();
        last.current = { x: ev.clientX, y: ev.clientY };
        follow(ev.clientX, ev.clientY);
      };
      const up = (ev: PointerEvent) => {
        const p = press.current;
        if (!p || ev.pointerId !== p.pointerId) return;
        const started = p.started;
        end();
        if (!started) return;
        const next = orderRef.current;
        if (changed(next)) dropRef.current(next);
        else setOrder(null);
      };
      const cancel = (ev: PointerEvent) => {
        if (!press.current || ev.pointerId !== press.current.pointerId) return;
        end();
        orderRef.current = [...keys];
        setOrder(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
  });

  /** On the heading's grip: the arrow keys move the column one place, and save. */
  const gripKeys = (key: string) => (e: React.KeyboardEvent) => {
    if (!live || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const cur = order ?? [...keys];
    const from = cur.indexOf(key);
    const to = from + (e.key === "ArrowLeft" ? -1 : 1);
    if (from < 0 || to < 0 || to >= cur.length) return;
    e.preventDefault();
    const next = [...cur];
    next.splice(from, 1);
    next.splice(to, 0, key);
    orderRef.current = next;
    setOrder(next);
    // The grip keeps the focus as its column moves.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-colh="${CSS.escape(key)}"] [data-grip]`)?.focus());
    dropRef.current(next);
  };

  /** A save that failed: back to the order as saved. */
  const revert = () => { orderRef.current = [...keys]; setOrder(null); };

  return { order: order ?? keys, held, headProps, gripKeys, revert };
}
