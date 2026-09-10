"use client";

import { useEffect, useState } from "react";

// Renders a relative-style timestamp on the client only. SSR emits the
// empty fallback (or whatever you pass in) so the initial server HTML
// matches the initial client render exactly — no hydration mismatch,
// no React #418, no tear-down + re-render of the parent list on
// every navigation.
//
// Why this matters: the thread list previously called
// `d.toLocaleTimeString(undefined, ...)`, which uses the runtime's
// default locale + timezone. Server defaults to en-US / UTC; the
// user's browser is whatever locale they're on (e.g. en-IN / IST).
// Different format strings → React aborts hydration and re-renders
// the entire subtree client-side. On a 68-row inbox that's ~700ms of
// pure waste per click.
export function RelativeTime({
  iso,
  fallback = "",
}: {
  iso: string | null;
  fallback?: string;
}) {
  const [text, setText] = useState(fallback);
  useEffect(() => {
    if (!iso) {
      setText(fallback);
      return;
    }
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    setText(
      sameDay
        ? d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })
        : d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }),
    );
  }, [iso, fallback]);
  return <>{text}</>;
}
