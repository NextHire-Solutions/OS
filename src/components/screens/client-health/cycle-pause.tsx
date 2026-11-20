"use client";

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ds";
import { names, shortDay, type CycleProgress, type CycleProgressView } from "@/lib/tools/client-health/cycle-pause-model";

/*
 * The billing-cycle pause on screen (cycle-pause.ts): Client Health's Intros / Billing cell and Campaign Management's
 * Client column. One read of /api/tools/client-health/cycle-pauses, which only people with Client Health can open;
 * for anyone else it is refused and nothing is shown, so no number reaches a screen its owner can't open.
 */

export interface CyclePauses {
  live: boolean;
  byHealthId: Map<string, CycleProgress>;
  byAnalyticsId: Map<string, CycleProgress>;
}

const EMPTY: CyclePauses = { live: false, byHealthId: new Map(), byAnalyticsId: new Map() };

export function useCyclePauses(enabled = true): CyclePauses {
  const [view, setView] = useState<CycleProgressView | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    fetch("/api/tools/client-health/cycle-pauses", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<CycleProgressView>) : null))
      .then((v) => { if (!gone) setView(v); })
      .catch(() => { /* shown without it */ });
    return () => { gone = true; };
  }, [enabled]);
  return useMemo(() => {
    if (!view) return EMPTY;
    const byHealthId = new Map<string, CycleProgress>();
    const byAnalyticsId = new Map<string, CycleProgress>();
    for (const c of view.clients) {
      byHealthId.set(c.chClientId, c);
      if (c.analyticsClientId) byAnalyticsId.set(c.analyticsClientId, c);
    }
    return { live: view.live, byHealthId, byAnalyticsId };
  }, [view]);
}

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET`;
};

/** What the pause did, or would do, for one client this cycle, as a hover. */
export function pauseDetail(p: CycleProgress, live: boolean): string {
  if (p.state === "paused") {
    const lines = [`Reached ${p.delivered ?? "?"} of ${p.required ?? "?"} on ${p.pausedAt ? when(p.pausedAt) : "?"}, so its sending campaigns were paused. They stay paused until someone resumes them.`];
    lines.push(p.paused.length ? `Paused: ${names(p.paused)}.` : "None was running.");
    if (p.leftRunning.length) lines.push(`Left running: ${p.leftRunning.map((c) => `${c.name} (${c.reason})`).join("; ")}.`);
    if (p.toRetry.length) lines.push(`Still trying to pause: ${p.toRetry.map((c) => `${c.name}${c.error ? ` (${c.error})` : ""}`).join("; ")}.`);
    lines.push("A campaign resumed this cycle keeps running until the next cycle reaches its target.");
    return lines.join("\n");
  }
  if (p.state === "reached") {
    return live
      ? "This cycle's target is reached. Its sending campaigns pause within 15 minutes."
      : "This cycle's target is reached. Auto-pause is in dry run, so nothing was paused: switched on, it would pause this client's sending campaigns.";
  }
  return "";
}

/** The chip beside Intros / Billing: shown only once the target is reached. */
export function CyclePauseBadge({ p, live }: { p: CycleProgress | undefined; live: boolean }) {
  if (!p || (p.state !== "paused" && p.state !== "reached")) return null;
  const title = pauseDetail(p, live);
  if (p.state === "paused") {
    return <Badge tone={p.toRetry.length ? "red" : "violet"} title={title}>{p.toRetry.length ? "Pause incomplete" : "Paused at target"}</Badge>;
  }
  return <Badge tone="outline" title={title}>{live ? "Target reached" : "Target reached · dry run"}</Badge>;
}

/** Campaign Management's line under the client: this cycle's introductions against its due. */
export function CycleProgressLine({ p, live }: { p: CycleProgress | undefined; live: boolean }) {
  if (!p || p.required == null || p.delivered == null || !p.nextBilling) return null;
  const title = [
    `${p.name}: ${p.delivered} of ${p.required} introductions due by the next billing date, ${shortDay(p.nextBilling)}${p.lastBilling ? ` (since the last one, ${shortDay(p.lastBilling)})` : ""}. Shared by all its campaigns, as Client Health's Intros / Billing shows it.`,
    pauseDetail(p, live),
    p.state === "skipped" && p.why ? `Auto-pause leaves it alone: ${p.why}.` : "",
  ].filter(Boolean).join("\n");
  return (
    <div className="cyc-line" title={title}>
      <span><span className="tnum">{p.delivered} / {p.required}</span> intros · due {shortDay(p.nextBilling)}</span>
      <CyclePauseBadge p={p} live={live} />
    </div>
  );
}
