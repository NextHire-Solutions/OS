"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { Search } from "lucide-react";

/*
 * The settings panels' shared controls, in the design's vocabulary.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE EXIST RATHER THAN RAW CLASSES
 *
 * Eight panels draw the same six things: a button, an icon button, a
 * destructive button, a labelled field, a search box and a switch row. Written
 * inline, that is six spellings of each, and the first one somebody gets
 * slightly wrong is the one nobody notices.
 *
 * The shapes come from `workspace.css` (`.btn`, `.btn-pri`, `.ib`, `.inp`) and
 * `mi-settings.css`. Nothing here invents a look.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT THE SHARED `Button` PRIMITIVE
 *
 * `mi-skin.css` already makes `[data-slot="button"]` look like `.btn`, and
 * inside a DIALOG that is exactly right — the dialog is shared, portalled
 * markup and must stay consistent with every other popup in the inbox, so the
 * dialogs below still use it.
 *
 * On the PAGE the markup is ours, and the design's own `.btn` is one class
 * instead of a component plus an override. `Btn` is that class with the one
 * thing `workspace.css` forgot: a disabled state. The design sheet has no
 * `:disabled` rule at all, so a disabled `.btn-pri` renders in full brand blue
 * and looks clickable — the same trap Onboarding's `Btn` works around, solved
 * the same way so the two screens behave identically.
 */

/** Disabled, made visible. `workspace.css` has no `:disabled` rule. */
export const DIM: React.CSSProperties = { opacity: 0.4, cursor: "not-allowed" };

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

/**
 * A borderless icon button — the design's `.ib`, one size down so it fits a
 * table row rather than an inbox row.
 *
 * `label` is mandatory: every one of these is icon-only, and an icon-only
 * control with no accessible name is a control a screen reader cannot announce
 * and a test cannot find.
 */
export function IconBtn({
  label,
  danger,
  disabled,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      className={`ib mis-ib${danger ? " mis-del" : ""}`}
      aria-label={label}
      title={rest.title ?? label}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/* ───────────────────────────────────────────────────────────────── chips */

/**
 * A label's colour, as the design draws it.
 *
 * `mockup/tabs.tsx` has the same mapping for the inbox row, and this is
 * deliberately NOT an import of it: that one folds blue into zinc, which is
 * harmless where a row shows one chip and wrong here, where the whole point of
 * the screen is choosing between all seven. `.lc-blue` is added by
 * `mi-settings.css` for the same reason.
 */
export function chipClass(color: string | null | undefined): string {
  const c = (color ?? "").toLowerCase();
  if (c.includes("green")) return "lc lc-green";
  if (c.includes("red")) return "lc lc-red";
  if (c.includes("amber") || c.includes("yellow")) return "lc lc-amber";
  if (c.includes("blue")) return "lc lc-blue";
  if (c.includes("pink") || c.includes("purple")) return "lc lc-pink";
  if (c.includes("stone")) return "lc lc-stone";
  return "lc lc-zinc";
}

/** A label chip in the design's own vocabulary. */
export function Chip({ name, color }: { name: string; color?: string | null }) {
  return <span className={chipClass(color)}>{name}</span>;
}

/* ─────────────────────────────────────────────────────────── write feedback */

export type ToastState = { text: string; bad?: boolean } | null;

/*
 * Why not `sonner`.
 *
 * The ported panels call `toast.success(...)` and `toast.error(...)` in eleven
 * places. `<Toaster />` is not mounted anywhere in this app — checked, not
 * assumed — so every one of those calls has been rendering NOTHING since the
 * port: saving a template, deleting a client, inviting a member and changing a
 * password all succeeded silently, and all failed silently too.
 *
 * Rather than mount a second toast system, these panels use the workspace's
 * own — the same fixed bottom-right line Onboarding, Client Health and
 * Analytics use, with the same 3s / 8s dwell (a failure is the one worth
 * reading, so it stays up longer).
 *
 * `role="status"` rather than `alert`: these confirm an action the reader just
 * took, so a screen reader should announce them politely.
 */
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
      data-mis-toast={toast.bad ? "bad" : "ok"}
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

/*
 * The toast, reachable from a nested dialog.
 *
 * Every panel's dialogs are separate components, and threading a `show` prop
 * through each of them is four extra parameters that exist only to carry a
 * status line. A context is one provider at the top of each panel.
 */
const ToastCtx = createContext<(next: ToastState) => void>(() => {});

export function ToastHost({ children }: { children: React.ReactNode }) {
  const { toast, show } = useToast();
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <Toast toast={toast} />
    </ToastCtx.Provider>
  );
}

export function useShowToast() {
  return useContext(ToastCtx);
}

/* ─────────────────────────────────────────────────────────── destructive */

/**
 * A destructive control that arms on the first click and fires on the second.
 *
 * The tool used `window.confirm` on five of these. Inside the workspace that is
 * the wrong control twice over: a native dialog is a jarring break from a
 * screen that is otherwise entirely the workspace's own, and it SUSPENDS the
 * page — so a delete guarded by `confirm()` is a delete no automated check can
 * ever prove works. That is not hypothetical here: creating a label from
 * settings was broken for a day without anything catching it.
 *
 * The consequence sentence the tool put inside its native dialog is not lost.
 * It moves to `title` and to the armed caption, so the warning still reaches
 * the reader before the second click.
 */
export function ConfirmButton({
  label,
  armedLabel,
  title,
  onConfirm,
  disabled,
  compact,
  children,
}: {
  label: string;
  armedLabel: string;
  title: string;
  onConfirm: () => void;
  disabled?: boolean;
  /** Icon-only, for a table row. The armed state grows into a worded button. */
  compact?: boolean;
  children?: React.ReactNode;
}) {
  const [armed, setArmed] = useState(false);

  function click() {
    if (!armed) {
      setArmed(true);
      // Disarms on its own, so a half-pressed delete cannot sit armed waiting
      // for an unrelated click a minute later.
      setTimeout(() => setArmed(false), 4000);
      return;
    }
    setArmed(false);
    onConfirm();
  }

  if (compact && !armed) {
    return (
      <IconBtn
        label={`${label} — ${title}`}
        title={title}
        danger
        disabled={disabled}
        data-armed="false"
        onClick={click}
      >
        {children}
      </IconBtn>
    );
  }

  return (
    <button
      className="btn"
      type="button"
      disabled={disabled}
      title={title}
      data-armed={armed ? "true" : "false"}
      aria-label={armed ? armedLabel : `${label} — ${title}`}
      onClick={click}
      style={{
        color: "var(--red)",
        borderColor: armed ? "var(--red)" : "var(--line)",
        background: armed ? "var(--red-bg)" : undefined,
        fontWeight: armed ? 700 : 600,
        whiteSpace: "nowrap",
        ...(compact ? { padding: "6px 11px", fontSize: 12.5 } : null),
        ...(disabled ? DIM : null),
      }}
    >
      {armed ? armedLabel : label}
    </button>
  );
}

/* ──────────────────────────────────────────────────────────────── fields */

/** A labelled control: label, the control, an optional hint under it. */
export function Field({
  label,
  optional,
  required,
  hint,
  htmlFor,
  children,
}: {
  label: React.ReactNode;
  optional?: React.ReactNode;
  required?: boolean;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mis-f" htmlFor={htmlFor}>
      <span className="mis-l">
        {label}
        {required ? <span className="mis-req"> *</span> : null}
        {optional ? <span className="mis-opt"> {optional}</span> : null}
      </span>
      {children}
      {hint ? <span className="mis-hint">{hint}</span> : null}
    </label>
  );
}

/** Title + explanation on the left, a switch (or anything) on the right. */
export function ToggleRow({
  title,
  hint,
  children,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mis-tog">
      <div className="mis-tog-t">
        <b>{title}</b>
        {hint ? <span>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** The design's `.inp` with a magnifier in it. */
export function Find({
  value,
  onChange,
  placeholder,
  label,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "placeholder"
>) {
  return (
    <div className="mis-find">
      <Search aria-hidden />
      <input
        {...rest}
        className="inp"
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** A section card with a heading and, optionally, an action beside it. */
export function Section({
  title,
  sub,
  action,
  children,
  bare,
}: {
  title?: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  /** No card — used where the children are already `.tbl-wrap`s. */
  bare?: boolean;
}) {
  const head =
    title || action ? (
      <div className="mis-h-row" style={{ marginBottom: children ? 16 : 0 }}>
        <div style={{ minWidth: 0 }}>
          {title ? <div className="mis-h">{title}</div> : null}
          {sub ? <div className="mis-sub">{sub}</div> : null}
        </div>
        {action ? <div style={{ flex: "none" }}>{action}</div> : null}
      </div>
    ) : null;

  if (bare) {
    return (
      <div className="mis-sec">
        {head}
        {children}
      </div>
    );
  }
  return (
    <div className="mis-sec card">
      {head}
      {children}
    </div>
  );
}
