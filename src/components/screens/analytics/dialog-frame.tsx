"use client";

import { useCallback, useRef, type ReactNode } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";

/*
 * The chrome every campaign-page dialog shares: a titled header, a body that
 * scrolls inside the 85vh cap, and a footer row of buttons.
 *
 * The tool has shadcn's Dialog/DialogHeader/DialogFooter; the workspace has
 * `ModalDialog`, which supplies the backdrop, the focus trap and the portal
 * but no layout. This is that layout, written once, in the same shape
 * `screens/clients-onboard.tsx` draws by hand.
 */
export function DialogFrame({
  open,
  onClose,
  title,
  description,
  width = 620,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  width?: number;
  children: ReactNode;
  footer: ReactNode;
}) {
  /*
   * ModalDialog's effect re-runs when `onClose` changes identity, and re-running
   * it moves focus back to the first field. Every dialog here builds its close
   * handler inline — and swaps it for a no-op while a write is running — so
   * without this the focus would jump on every keystroke in a search box. The
   * latest handler is read through a ref; the identity ModalDialog sees never
   * changes.
   */
  const latest = useRef(onClose);
  latest.current = onClose;
  const stableClose = useCallback(() => latest.current(), []);

  return (
    <ModalDialog open={open} onClose={stableClose} width={width} label={title}>
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line-soft)", flex: "none" }}>
          <div style={{ fontWeight: 650, fontSize: 14 }}>{title}</div>
          {description ? (
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>{description}</div>
          ) : null}
        </div>
        <div style={{ padding: 16, overflowY: "auto", flex: 1, minHeight: 0, display: "grid", gap: 12, alignContent: "start", fontSize: 13 }}>
          {children}
        </div>
        <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid var(--line-soft)", flex: "none", justifyContent: "flex-end", flexWrap: "wrap" }}>
          {footer}
        </div>
      </div>
    </ModalDialog>
  );
}

/** The amber "careful" box the tool draws before every irreversible step. */
export function Warn({ children }: { children: ReactNode }) {
  return (
    <div className="anno" style={{ margin: 0, fontSize: 12.5 }}>
      {children}
    </div>
  );
}

/** The red failure box. */
export function Fail({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--red)", background: "var(--red-bg)", color: "var(--red)",
        borderRadius: "var(--r-md)", padding: "8px 10px", fontSize: 12.5, whiteSpace: "pre-line",
      }}
    >
      {children}
    </div>
  );
}

/** A quiet bordered box for numbers and lists. */
export function Panel({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: 10, ...style }}>
      {children}
    </div>
  );
}
