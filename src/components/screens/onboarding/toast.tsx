"use client";

import { useCallback, useRef, useState } from "react";

/*
 * The workspace's write-feedback idiom, as a hook.
 *
 * Copied in shape from `screens/client-health/sync-button.tsx`: a fixed
 * bottom-right status line, ink for success and red for failure, dismissing
 * itself after 3s or 8s — a failure is left up longer because it is the one
 * worth reading.
 *
 * `role="status"` rather than an alert: these confirm an action the reader just
 * took, so a screen reader should announce them politely rather than interrupt.
 */

export type ToastState = { text: string; bad?: boolean } | null;

/*
 * How a disabled control looks.
 *
 * workspace.css styles `.btn` and `.btn-pri` but has NO `:disabled` rule, so a
 * disabled primary button renders in full brand blue — indistinguishable from a
 * live one until you click it and nothing happens. Agent Search's pager already
 * works around this inline with exactly these two properties; `Btn` below just
 * makes it automatic, so a disabled button can never again look clickable.
 */
export const DIM: React.CSSProperties = { opacity: 0.4, cursor: "not-allowed" };

/**
 * A workspace button that dims itself when disabled.
 *
 * Defaults to `type="button"`: these screens have no forms, and a bare <button>
 * inside one would submit it.
 */
export function Btn({
  primary,
  disabled,
  style,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={primary ? "btn btn-pri" : "btn"}
      disabled={disabled}
      style={{ ...(disabled ? DIM : null), ...style }}
    >
      {children}
    </button>
  );
}

export function useToast() {
  const [toast, setToast] = useState<ToastState>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((next: ToastState) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(next);
    if (next) {
      timer.current = setTimeout(() => setToast(null), next.bad ? 8000 : 3000);
    }
  }, []);

  return { toast, show };
}

export function Toast({ toast }: { toast: ToastState }) {
  if (!toast) return null;
  return (
    <div
      role="status"
      style={{
        position: "fixed",
        right: 26,
        bottom: 22,
        zIndex: 60,
        maxWidth: 460,
        padding: "11px 16px",
        borderRadius: "var(--r-md)",
        background: toast.bad ? "var(--red)" : "var(--ink)",
        color: "#fff",
        fontSize: 13,
        fontWeight: 500,
        boxShadow: "var(--sh-raise)",
      }}
    >
      {toast.text}
    </div>
  );
}

/**
 * A destructive button that arms on the first click and fires on the second.
 *
 * The tool uses `window.confirm`. Inside the workspace that is the wrong control
 * twice over: a native dialog is a jarring break from a screen that is otherwise
 * entirely the workspace's own, and it suspends the page in a way no automated
 * check can drive — so a delete button guarded by `confirm()` is a button no test
 * can prove works.
 *
 * The consequence text the tool put in its dialog is not lost; it moves to
 * `title` and to the armed caption, so the warning still reaches the reader
 * before the second click.
 */
export function ConfirmButton({
  label,
  armedLabel,
  title,
  onConfirm,
  disabled,
}: {
  label: string;
  armedLabel: string;
  title: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);

  return (
    <button
      className="btn"
      type="button"
      disabled={disabled}
      title={title}
      aria-label={armed ? armedLabel : `${label} — ${title}`}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          // Disarms on its own, so a half-pressed delete cannot sit armed
          // waiting for an unrelated click later.
          setTimeout(() => setArmed(false), 4000);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      style={{
        color: "var(--red)",
        borderColor: armed ? "var(--red)" : "var(--line)",
        background: armed ? "var(--red-bg)" : undefined,
        fontWeight: armed ? 700 : 600,
        whiteSpace: "nowrap",
        ...(disabled ? DIM : null),
      }}
    >
      {armed ? armedLabel : label}
    </button>
  );
}
