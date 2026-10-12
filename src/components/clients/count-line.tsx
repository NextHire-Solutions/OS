"use client";

import { useEffect, useState } from "react";

import type { ClientCounts, CountedTool } from "@/lib/reconcile/client-counts";

import { listed } from "@/lib/reconcile/row-note";

export { rowNote } from "@/lib/reconcile/row-note";

/*
 * The same client count on every tool's client screen: the master record's
 * total and statuses, then — only where this tool's table differs — which
 * rows make the difference, by name. See lib/reconcile/client-counts.ts.
 */

let shared: Promise<ClientCounts | null> | null = null;
function fetchCounts(): Promise<ClientCounts | null> {
  shared ??= fetch("/api/workspace/clients/counts", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .finally(() => { setTimeout(() => { shared = null; }, 30_000); });
  return shared;
}

const NONE: readonly string[] = [];

const list = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** The shared counts, for a screen that marks its own extra rows. */
export function useClientCounts(): ClientCounts | null {
  const [c, setC] = useState<ClientCounts | null>(null);
  useEffect(() => {
    let live = true;
    void fetchCounts().then((v) => { if (live) setC(v); });
    return () => { live = false; };
  }, []);
  return c;
}

/*
 * `omit` names rows the tool's table holds but THIS screen does not list —
 * Client Portals leaves out Master Inbox's "Unknown" bucket, which is not a
 * portal. They come off the row count and out of the explanation, so the
 * number in the sentence is the number of rows on the screen.
 */
export function ClientCountLine({ tool, noun = "rows", omit = NONE }: { tool?: CountedTool; noun?: string; omit?: readonly string[] }) {
  const c = useClientCounts();
  if (!c) return null;

  const t = tool ? c.tools[tool] : undefined;
  const s = c.byStatus;
  const parts: string[] = [];
  const { rows, extras } = t ? listed(t, omit) : { rows: 0, extras: [] };
  if (t && rows !== c.total) {
    if (t.secondRows.length) {
      parts.push(`${t.secondRows.length} second portal${t.secondRows.length === 1 ? "" : "s"} of a client already counted (${list(t.secondRows.map((r) => r.name))})`);
    }
    if (extras.length) {
      parts.push(`${extras.length} ${extras.length === 1 ? "row that is" : "rows that are"} not a client (${list(extras.map((r) => r.name))})`);
    }
  }
  const missing = t ? t.absent : [];

  return (
    <div className="ds-countline" role="note">
      <span className="ds-countline-main">
        <b>{c.total} clients</b>
        <span><i className="st-dot-only st-active" aria-hidden="true" /> {s.active} active</span>
        {s.onboarding ? <span><i className="st-dot-only st-onboarding" aria-hidden="true" /> {s.onboarding} onboarding</span> : null}
        <span><i className="st-dot-only st-paused" aria-hidden="true" /> {s.paused} paused</span>
        <span><i className="st-dot-only st-churned" aria-hidden="true" /> {s.churned} churned</span>
        <em>the same count in every tool</em>
      </span>
      {parts.length ? (
        <span className="ds-countline-why">
          This table has {rows} {noun}: the {t!.present} clients, plus {parts.join(", plus ")}.{" "}
          <a href="/consistency">Why →</a>
        </span>
      ) : null}
      {missing.length ? (
        <span className="ds-countline-why">
          {missing.length} client{missing.length === 1 ? " has" : "s have"} no row here: {list(missing.map((m) => m.name))}. <a href="/consistency">Details →</a>
        </span>
      ) : null}
    </div>
  );
}
