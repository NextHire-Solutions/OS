"use client";

import { useEffect, useState } from "react";

import type { DashboardClient } from "@/lib/tools/client-health/types";
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

/*
 * The data as it currently stands, INCLUDING optimistic edits.
 *
 * Separate from `inflight` because that promise resolves once and never
 * changes, while this moves every time somebody pauses a client or saves the
 * modal. Held at module scope for the same reason the promise is: the three
 * screens are separate mounts, and an edit made on Weekly has to be there when
 * you switch to Bi-Weekly rather than silently reverting.
 */
let current: ClientHealthWeeklyData | null = null;

export function loadClientHealth(): Promise<ClientHealthWeeklyData> {
  if (inflight) return inflight;

  inflight = fetch("/api/tools/client-health", { credentials: "same-origin" })
    .then(async (res) => {
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Client Health returned ${res.status}`);
      }
      const data = (await res.json()) as ClientHealthWeeklyData;
      current = data;
      return data;
    })
    .catch((error) => {
      inflight = null;
      throw error;
    });

  return inflight;
}

/*
 * Subscribers, so a refresh reaches every mounted screen.
 *
 * All three Client Health screens stay mounted once visited. After a sync, the
 * one you are looking at must update — but so must the other two, or switching
 * to Bi-Weekly would show pre-sync numbers with no indication they are stale.
 */
const listeners = new Set<(d: ClientHealthWeeklyData) => void>();

/**
 * Discards the cached data and fetches it again, then tells every mounted
 * screen. Called after a sync: the tool has new numbers, so ours are stale by
 * definition and showing the old ones reads as the sync having failed.
 */
export async function refreshClientHealth(): Promise<ClientHealthWeeklyData> {
  inflight = null;
  const data = await loadClientHealth();
  publish(data);
  return data;
}

function publish(data: ClientHealthWeeklyData): void {
  current = data;
  for (const notify of listeners) notify(data);
}

/**
 * Applies a change to the client list and tells every mounted screen.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EDITS ARE OPTIMISTIC
 *
 * Pausing a client is one PATCH against a database in another datacentre. Wait
 * for it and the pause button does nothing for half a second, which reads as a
 * broken button and gets clicked again. So the row changes immediately and the
 * caller rolls it back if the request fails — the tool does exactly this, and
 * `rollback` below is what makes that honest rather than a lie you never
 * correct.
 *
 * The derived `rows`/`summary` from the server render are DROPPED on any edit.
 * They were computed from the pre-edit clients, and keeping them would leave a
 * paused client still counted in the headline numbers until the next reload.
 */
export function patchClients(
  update: (clients: DashboardClient[]) => DashboardClient[],
): void {
  if (!current) return;
  const { rows: _rows, summary: _summary, ...rest } = current;
  publish({ ...rest, clients: update(current.clients) });
}

/** Replaces one client, by id. The common case. */
export function patchClient(id: string, change: Partial<DashboardClient>): void {
  patchClients((list) => list.map((c) => (c.id === id ? { ...c, ...change } : c)));
}

export function removeClientLocally(id: string): void {
  patchClients((list) => list.filter((c) => c.id !== id));
}

export function addClientLocally(client: DashboardClient): void {
  patchClients((list) => [...list, client]);
}

/** The client list as the store currently holds it, or null before first load. */
export function currentClients(): DashboardClient[] | null {
  return current?.clients ?? null;
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

  /*
   * A server-rendered screen never went through `loadClientHealth`, so the
   * store has nothing in it and the first edit would find no list to change.
   * Seeding it here is what makes the modal work on a direct link.
   */
  if (initial && !current) current = initial;

  // Stay subscribed for the screen's whole life, not just until it has data:
  // a sync must update a screen that loaded long ago.
  useEffect(() => {
    listeners.add(setData);
    return () => { listeners.delete(setData); };
  }, []);

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
