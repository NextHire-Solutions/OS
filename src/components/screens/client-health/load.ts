"use client";

import { useEffect, useState } from "react";

import type { ClientHealthWeeklyData } from "@/lib/tools/client-health/weekly";

/*
 * Client Health's data, fetched once and shared by its three screens.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Every screen in the workspace used to be server-rendered into every page, so
 * every route carried Client Health's full client list — 48 clients, each with
 * every week of metrics it has ever recorded. Measured on the live deployment:
 *
 *   /performance   925,690 bytes of HTML
 *                  722,535 of them one RSC chunk — the client list
 *
 * 92% of the page was data that page does not display. It was paid on /,
 * /roster, /performance and /consistency alike, on every single load.
 *
 * Now the three Client Health screens load it themselves, on first use.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROMISE IS CACHED AT MODULE SCOPE
 *
 * All three screens mount together, so three components ask for this data at
 * once. Caching the PROMISE rather than the result means they share one
 * request — caching the result would still let three requests start before the
 * first one lands, which is the usual way this optimisation quietly does
 * nothing.
 *
 * A failed load is not cached: it clears itself so the next visit retries
 * rather than showing the same error until reload.
 */

let inflight: Promise<ClientHealthWeeklyData> | null = null;

export function loadClientHealth(): Promise<ClientHealthWeeklyData> {
  if (inflight) return inflight;

  inflight = fetch("/api/tools/client-health", { credentials: "same-origin" })
    .then(async (res) => {
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Client Health returned ${res.status}`);
      }
      return (await res.json()) as ClientHealthWeeklyData;
    })
    .catch((error) => {
      inflight = null;
      throw error;
    });

  return inflight;
}

export interface ScreenData {
  data: ClientHealthWeeklyData | null;
  error: string | null;
  loading: boolean;
}

/**
 * The data for a Client Health screen.
 *
 * `initial` is present only for the screen the page was opened on — that one is
 * server-rendered with its data so a direct link paints immediately, with no
 * loading state and no second round trip. The other two fetch on mount and
 * then stay mounted, so switching between them afterwards is instant.
 */
export function useClientHealth(initial: ClientHealthWeeklyData | null): ScreenData {
  const [data, setData] = useState<ClientHealthWeeklyData | null>(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) return;
    let live = true;
    loadClientHealth().then(
      (d) => { if (live) setData(d); },
      (e: unknown) => { if (live) setError(e instanceof Error ? e.message : "Could not load Client Health"); },
    );
    return () => { live = false; };
  }, [initial]);

  return { data, error, loading: !data && !error };
}
