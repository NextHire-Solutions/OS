"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/*
 * A centred modal, for the dialogs that are TASKS rather than pickers.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT AnchoredPanel
 *
 * Anchoring is right for a filter popover: it belongs to the control you just
 * clicked, and staying next to that control is what makes it feel attached.
 *
 * It is wrong for Onboard, Edit and Delete. Those are full forms opened from a
 * button in the top-right corner, so anchoring pinned a 620px form to the
 * right-hand edge — hanging off the corner, overlapping the summary cards and
 * the table beneath, with the client list showing through beside it. The
 * delete dialog was worse: tall enough to need its own scrollbar while the page
 * behind it stayed fully interactive.
 *
 * A task dialog wants the opposite of attachment. It wants the page to step
 * back: dimmed, centred, one thing to deal with.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES THAT A DIV CANNOT
 *
 *   · portals to <body>, so no ancestor's `overflow` can clip it — the same
 *     reason AnchoredPanel exists, and the bug that started all of this
 *   · caps at 85vh and scrolls INSIDE, so a long form never runs off-screen
 *   · locks the page behind it, so the background cannot be scrolled away
 *   · returns focus to whatever opened it, so the keyboard does not get lost
 */

const Z = 40; // above AnchoredPanel's 35 — a modal outranks a popover

export interface ModalDialogProps {
  open: boolean;
  onClose: () => void;
  /** Max width in px. The dialog shrinks below this on a narrow viewport. */
  width?: number;
  /** Accessible name. */
  label: string;
  children: ReactNode;
}

export function ModalDialog({ open, onClose, width = 620, label, children }: ModalDialogProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  /*
   * Portals need a DOM that exists. On the server, and on the very first client
   * render, it does not — so mount is gated rather than guarded with a
   * `typeof window` check inside render, which would desync hydration.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;

    restoreTo.current = document.activeElement as HTMLElement | null;
    // Move focus into the dialog so Escape and Tab go here, not to the page.
    const t = window.setTimeout(() => {
      const first = cardRef.current?.querySelector<HTMLElement>(
        "input:not([type=hidden]), select, textarea, button, [tabindex]:not([tabindex='-1'])",
      );
      (first ?? cardRef.current)?.focus();
    }, 0);

    /*
     * Lock the page behind the dialog. The scrollbar is replaced with padding
     * of the same width, otherwise the whole layout shifts sideways the moment
     * the dialog opens and shifts back when it closes.
     */
    const { body } = document;
    const prevOverflow = body.style.overflow;
    const prevPad = body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Keep Tab inside the dialog — otherwise focus walks into the page
      // behind it, which is inert to the eye but not to the keyboard.
      const focusables = cardRef.current?.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), " +
          "select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      if (!focusables || focusables.length === 0) return;
      const list = [...focusables].filter((el) => el.offsetParent !== null || el === cardRef.current);
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !cardRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);

    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPad;
      restoreTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      data-modal-backdrop=""
      onMouseDown={(e) => {
        // Only a press that STARTS on the backdrop closes it. Using click
        // would also fire when a drag inside the form happens to end out here,
        // which throws away what the person just typed.
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z,
        background: "rgba(16,20,28,.44)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        overflowY: "auto",
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-modal-dialog=""
        tabIndex={-1}
        style={{
          width: "100%",
          maxWidth: width,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-md)",
          boxShadow: "var(--sh-raise)",
          // `overflow:hidden` keeps the rounded corners, and the children
          // handle their own scrolling within the 85vh cap.
          overflow: "hidden",
          outline: "none",
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
