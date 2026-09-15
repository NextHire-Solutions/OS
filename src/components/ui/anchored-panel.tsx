"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/*
 * A popover panel that cannot be clipped by its ancestors.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `.an-filter` is `overflow-x: auto`, so the filter bar scrolls sideways on a
 * narrow pane. That single declaration also clips VERTICALLY, and it is not
 * obvious why: CSS does not allow one axis to be `auto` while the other stays
 * `visible`. When they disagree, the spec computes `visible` to `auto`. So
 * `overflow-x: auto` silently makes `overflow-y: auto` too, and every
 * absolutely-positioned panel inside the bar was cut off at the bar's own
 * bottom edge — about 30px of a 300px-tall list, with the KPI cards painting
 * over the rest. No z-index can fix that; the pixels are clipped before
 * stacking is considered.
 *
 * Raising the ancestor's overflow is not an option either — the bar genuinely
 * needs to scroll. The deployed tool has neither problem because it uses a
 * Radix popover, which PORTALS to `<body>`. This is that behaviour, written
 * out: the panel renders at the end of the document and positions itself
 * against the trigger's viewport rect, so no ancestor's overflow, transform or
 * stacking context can touch it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT HAS TO GET RIGHT
 *
 *   · `position: fixed` measured from `getBoundingClientRect()`. Fixed is
 *     relative to the VIEWPORT here because `<body>` has no transform — the
 *     trap that put a Client Health dialog 292px below the fold lives in
 *     ancestors, and portalling is exactly what escapes it.
 *   · Reposition on scroll with `capture: true`. The workspace scrolls inner
 *     panes, not the window, so a bubbling scroll listener never fires.
 *   · Flip above the trigger when there is no room below, and clamp to the
 *     viewport horizontally, so a panel near the right edge stays reachable.
 *   · Close on outside pointerdown and on Escape, like the Radix popover it
 *     replaces.
 *
 * z-index 35 is deliberate: above page content (30) and below the scrim (40),
 * so a filter panel never paints over a modal or the command palette.
 */

const GAP = 8;
const EDGE = 8;
const Z = 35;

export interface AnchoredPanelProps {
  /** The trigger. Its rect is what the panel is positioned against. */
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** Fixed panel width. Omit to size to content (the range picker does). */
  width?: number;
  /**
   * Which trigger edge the panel lines up with. `end` is the old `right: 0`
   * — it matters for panels near the right of the pane, where left-aligning
   * would push them under the viewport clamp and shift them sideways.
   */
  align?: "start" | "end";
  /** Labels the panel for assistive tech, matching the trigger's name. */
  label?: string;
  children: React.ReactNode;
}

interface Placement {
  top: number;
  left: number;
  /** Room actually available, so a long list scrolls instead of overflowing. */
  maxHeight: number;
}

export function AnchoredPanel({
  anchorRef,
  open,
  onClose,
  width,
  align = "start",
  label,
  children,
}: AnchoredPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  /*
   * Portals need a DOM that exists. On the server, and on the very first
   * client render, it does not — so mount is gated rather than guarded with a
   * `typeof window` check inside render, which would desync hydration.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const w = width ?? panelRef.current?.offsetWidth ?? 0;
    // Line up with the requested trigger edge, then pull back inside the
    // viewport. Clamping happens after alignment so `end` degrades to a
    // nudge rather than jumping to the other side of the trigger.
    let left = align === "end" && w > 0 ? r.right - w : r.left;
    if (w > 0 && left + w > vw - EDGE) left = vw - w - EDGE;
    if (left < EDGE) left = EDGE;

    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const h = panelRef.current?.offsetHeight ?? 0;

    // Flip up only when below genuinely cannot hold the panel AND above is
    // roomier. Flipping on a narrow miss makes the panel jump about as the
    // list filters down, which reads as a glitch.
    const flip = h > below && above > below;
    setPlace({
      top: flip ? Math.max(EDGE, r.top - GAP - h) : r.bottom + GAP,
      left,
      // Clamped to the viewport as well as to the side we chose: an anchor
      // scrolled far off-screen reports a huge `above`, and a panel must
      // never ask for more height than the screen has.
      maxHeight: Math.min(vh - EDGE * 2, Math.max(140, flip ? above : below)),
    });
  }, [anchorRef, width, align]);

  /*
   * Measure before paint. `useLayoutEffect` rather than `useEffect` so the
   * panel never shows for one frame at (0,0) before snapping into place.
   */
  useLayoutEffect(() => {
    if (!open) { setPlace(null); return; }
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;

    // capture:true — the workspace scrolls inner panes, so a scroll on
    // `.mi-conv-main` or `.an-body` never bubbles to window.
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      // The trigger toggles itself; closing here too would reopen-and-close.
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);

    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, onClose, reposition, anchorRef]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      data-anchored-panel=""
      style={{
        position: "fixed",
        top: place?.top ?? -9999,
        left: place?.left ?? -9999,
        zIndex: Z,
        width,
        maxHeight: place?.maxHeight,
        display: "flex",
        flexDirection: "column",
        background: "var(--surface)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-md)",
        boxShadow: "var(--sh-raise)",
        overflow: "hidden",
        // Hidden until measured, so it never flashes at the wrong spot.
        visibility: place ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
