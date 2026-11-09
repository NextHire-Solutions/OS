"use client";

/*
 * "Take the tour" on the Help page (4 Nov). A short walk round the portal: it opens each page and points at it in the
 * sidebar, one step at a time. It only looks: the page behind can't be clicked while it runs, and nothing is saved. The
 * handoff drew only the button, so this is drawn in the portal's own colours (preview.css). On a phone the sidebar is
 * a closed menu, so there is nothing to point at: the card sits at the bottom, over the page it opened.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { PreviewView } from "@/lib/crm-preview/model";
import { CARD_WIDTH, cardPlace, holeRadius, TOUR_STEPS } from "@/lib/crm-preview/tour-steps";

type Hole = { top: number; left: number; width: number; height: number; borderRadius: number };

export function Tour({ go, onClose }: { go: (view: PreviewView) => void; onClose: () => void }) {
  const [at, setAt] = useState(0);
  const [hole, setHole] = useState<Hole | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const step = TOUR_STEPS[at];
  const last = at === TOUR_STEPS.length - 1;

  // Opens the page first, so what's behind the card is that page.
  useEffect(() => { if (step.view) go(step.view); }, [step.view]); // eslint-disable-line react-hooks/exhaustive-deps -- `go` is remade every draw; the step decides

  const measure = useCallback(() => {
    const el = step.target ? document.querySelector<HTMLElement>(step.target) : null;
    const r = el?.getBoundingClientRect();
    // Not on screen (a phone's closed menu): nothing to point at.
    const seen = r && r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
    const now = seen && el && window.innerWidth > 760 ? { top: r.top - 4, left: r.left - 4, width: r.width + 8, height: r.height + 8, borderRadius: holeRadius(getComputedStyle(el).borderTopLeftRadius, r.width, r.height) } : null;
    setHole((was) => (was?.top === now?.top && was?.left === now?.left && was?.width === now?.width && was?.height === now?.height && was?.borderRadius === now?.borderRadius ? was : now));
    const size = card.current?.getBoundingClientRect();
    if (!size) return;
    const spot = window.innerWidth <= 760 ? null : cardPlace(now, size, { width: window.innerWidth, height: window.innerHeight });
    setPlace((was) => (was?.top === spot?.top && was?.left === spot?.left ? was : spot));
  }, [step.target]);

  useLayoutEffect(() => {
    if (step.target) document.querySelector(step.target)?.scrollIntoView({ block: "nearest" });
    measure();
  }, [measure, step.target]);
  // Kept on it every moment: what's pointed at moves when the page behind finishes loading (its bar grows, late, on a
  // slow market), and a timer can only guess when that is. Nothing changes unless it really moved.
  useEffect(() => {
    let frame = 0;
    const tick = () => { measure(); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [measure]);

  useEffect(() => { next.current?.focus(); }, [at]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); if (last) onClose(); else setAt((n) => n + 1); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); setAt((n) => Math.max(0, n - 1)); return; }
      if (e.key === "Tab") {
        // The page behind is out of reach: Tab stays on the card.
        const on = [...(card.current?.querySelectorAll<HTMLElement>("button") ?? [])];
        if (!on.length) return;
        const i = on.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        on[(i + (e.shiftKey ? -1 : 1) + on.length) % on.length].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [last, onClose]);

  return (
    <div className="cpv-tour">
      <div className={hole ? "cpv-tour-back" : "cpv-tour-back cpv-tour-dim"} />
      {hole ? <div className="cpv-tour-hole" style={hole} /> : null}
      <div
        ref={card}
        className="cpv-tour-card"
        role="dialog"
        aria-modal="true"
        aria-label="Portal tour"
        style={place ? { top: place.top, left: place.left, width: CARD_WIDTH } : undefined}
      >
        <div className="cpv-tour-count" aria-live="polite">Step {at + 1} of {TOUR_STEPS.length}</div>
        <h2>{step.title}</h2>
        <p>{step.text}</p>
        <div className="cpv-tour-acts">
          {last ? <span /> : <button type="button" className="cpv-tour-skip" onClick={onClose}>Skip tour</button>}
          <div className="cpv-tour-move">
            {at > 0 ? <button type="button" className="cpv-tour-btn" onClick={() => setAt((n) => n - 1)}>Back</button> : null}
            <button ref={next} type="button" className="cpv-tour-btn cpv-tour-pri" onClick={() => (last ? onClose() : setAt((n) => n + 1))}>{last ? "Done" : at === 0 ? "Start" : "Next"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
