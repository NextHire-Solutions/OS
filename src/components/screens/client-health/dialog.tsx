"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/*
 * The overlay both Client Health dialogs sit in.
 *
 * Written here rather than pulled from the tool because the tool's dialog is
 * styled by its own stylesheet, which is not this design. What IS taken from
 * it is the behaviour: click the backdrop to dismiss, Escape to dismiss.
 *
 * Escape is ours — the tool wires it on the campaigns popup and forgets it on
 * the client modal, which means the modal traps you in it unless you find the
 * Cancel button. That is a bug rather than a decision, so it is not preserved.
 *
 * The panel is a `.card`'s material — white on the scrim, 20px corners, the
 * raised shadow — so a dialog reads as the same system as everything under it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT PORTALS TO <body>
 *
 * `position: fixed` is NOT relative to the viewport when an ancestor has a
 * transform, a filter or containment — it is relative to that ancestor. The
 * workspace's `section.screen.on` carries both a transform and a filter for its
 * screen transition, so the scrim rendered in place measured
 * 284, -3518, 1218x8618: anchored to the pane, and as tall as the pane's whole
 * scroll height. The dialog then centred in 8618px rather than in 950, which
 * put it 292px BELOW THE FOLD — its Save and Cancel buttons off the bottom of
 * the screen, unreachable — and pushed it right of centre by the width of the
 * rail.
 *
 * Portalling to <body> puts it outside that containing block, which is why the
 * Master Inbox dialogs centre correctly: theirs already do.
 */

export function Dialog({
  onClose,
  labelledBy,
  width = 520,
  children,
}: {
  onClose: () => void;
  labelledBy: string;
  width?: number;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /*
   * Focus moves into the panel on open.
   *
   * Without it the keyboard is still on the button that opened this, so Tab
   * walks the page behind the scrim and Enter re-opens the dialog that is
   * already open.
   */
  useEffect(() => {
    const first = panel.current?.querySelector<HTMLElement>(
      "input, select, textarea, button",
    );
    (first ?? panel.current)?.focus();
  }, []);

  /*
   * Rendered only after mount. `document` does not exist while the server
   * renders, and a portal that differs between server and client is a
   * hydration mismatch.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div
      className="scrim on"
      style={{
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        overflowY: "auto",
      }}
      // Only a click that both starts and ends on the backdrop dismisses.
      // Otherwise a text selection dragged out of an input closes the dialog
      // and loses everything typed into it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={{
          width: `min(${width}px, 100%)`,
          maxHeight: "calc(100vh - 48px)",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--sh-raise)",
          outline: 0,
        }}
      >
        {children}
        </div>
    </div>,
    document.body,
  );
}

/** A dialog's title block. */
export function DialogHead({
  id,
  title,
  sub,
}: {
  id: string;
  title: string;
  sub?: React.ReactNode;
}) {
  return (
    <div style={{ padding: "22px 24px 0" }}>
      <h2
        id={id}
        style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-.02em", color: "var(--ink)" }}
      >
        {title}
      </h2>
      {sub ? (
        <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
          {sub}
        </p>
      ) : null}
    </div>
  );
}

/** The scrolling middle of a dialog. */
export function DialogBody({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "18px 24px", overflowY: "auto", flex: 1, minHeight: 0 }}>
      {children}
    </div>
  );
}

/** The action row. Buttons sit right, primary last — the house order. */
export function DialogFoot({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        gap: 10,
        padding: "16px 24px 22px",
        borderTop: "1px solid var(--line-soft)",
      }}
    >
      {children}
    </div>
  );
}

/** One labelled form control, with optional help text below it. */
export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: 16 }}>
      <span
        style={{
          display: "block",
          marginBottom: 6,
          fontSize: 13,
          fontWeight: 600,
          color: "var(--ink-2)",
        }}
      >
        {label}
      </span>
      {children}
      {help ? (
        <span
          style={{
            display: "block",
            marginTop: 6,
            fontSize: 12.5,
            lineHeight: 1.45,
            color: "var(--muted)",
          }}
        >
          {help}
        </span>
      ) : null}
    </label>
  );
}
