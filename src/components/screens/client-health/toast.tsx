"use client";

import { useEffect, useState } from "react";

/*
 * The one-line confirmations Client Health shows after every write.
 *
 * A bus rather than a prop, because the things that raise a toast are spread
 * across the screen — a row's pause button, the modal's save, the sync button,
 * a delete — and threading a setter down to each of them would put plumbing in
 * every component signature for a string that appears in one corner.
 *
 * Failures stay up longer than successes and are red. A failed pause that
 * vanished in two seconds is a pause the reader believes worked.
 */

export interface ToastMessage {
  text: string;
  bad?: boolean;
}

type Listener = (t: ToastMessage | null) => void;
const listeners = new Set<Listener>();

export function toast(text: string, bad = false): void {
  for (const notify of listeners) notify({ text, bad });
}

/** Mount once per screen. Renders nothing until something is said. */
export function ToastHost() {
  const [message, setMessage] = useState<ToastMessage | null>(null);

  useEffect(() => {
    listeners.add(setMessage);
    return () => { listeners.delete(setMessage); };
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), message.bad ? 8000 : 2600);
    return () => clearTimeout(t);
  }, [message]);

  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        right: 22,
        bottom: 22,
        zIndex: 60,
        maxWidth: 460,
        padding: "12px 16px",
        borderRadius: 12,
        fontSize: 13.5,
        lineHeight: 1.5,
        color: "#fff",
        background: message.bad ? "var(--red)" : "var(--ink)",
        boxShadow: "0 10px 34px rgba(16,20,28,.24)",
      }}
    >
      {message.text}
    </div>
  );
}
