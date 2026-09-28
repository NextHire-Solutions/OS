"use client";

import { useEffect, useState } from "react";

import type { LastCheck } from "@/lib/reconcile/last-result";

/*
 * §16 on Home: the daily consistency check's latest answer, so a problem is
 * seen without anyone opening the Consistency screen to look for it.
 *
 * Loud only when there is something to act on. An all-clear is one quiet
 * line, and "not checked yet" (the minute or two after a deploy) shows
 * nothing rather than a reassurance the system has not earned.
 */
export function DailyCheckNotice() {
  const [last, setLast] = useState<LastCheck | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/workspace/reconcile/last", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (live && b?.last) setLast(b.last as LastCheck); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  if (!last) return null;
  const when = new Date(last.generatedAt).toLocaleString("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

  if (!last.actionable) {
    return (
      <p className="dc-ok" data-daily-check="clear">
        Consistency check, {when} ET: every tool agrees across {last.clientsChecked} clients.
      </p>
    );
  }
  return (
    <div className={`anno dc-alert dc-${last.severity}`} role="status" data-daily-check={last.severity}>
      <b>{last.title}</b>
      <ul>
        {/* The lines are written for Slack; its emoji codes (":warning:") read as noise here. */}
        {last.lines.map((l) => <li key={l}>{l.replace(/:[a-z0-9_+-]+:\s*/g, "")}</li>)}
      </ul>
      <a href="/consistency">Open Consistency</a> · checked {when} ET
    </div>
  );
}
