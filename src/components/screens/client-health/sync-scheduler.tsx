"use client";

import { useEffect } from "react";

/*
 * Keeps Client Health's sync on its schedule while somebody is looking at it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT RUNS FROM THE BROWSER
 *
 * The tool's sync ran every fifteen minutes from a Railway cron service. The
 * workspace has none, and the outbox sweeper (shell/outbox-sweeper.tsx) has
 * already worked through the alternatives: a new service, or a cron on the web
 * service that restarts the thing it is meant to keep alive. Its answer holds
 * here too — whoever has the workspace open supplies the clock.
 *
 * The tab is ONLY a clock. Every tick asks POST /sync/tick, and the server
 * decides whether a run is due from `sync_runs` — one run per quarter-hour
 * slot, the cron's own rule — and refuses a second run while one is in
 * flight. So ten open tabs are no different from one, and a tab cannot start
 * anything the server would not have started on its own.
 *
 * What it does not cover is the quarter hour at 3am with nobody signed in.
 * The numbers are then as old as the last open tab, and the toolbar says so.
 * If that ever matters, a Railway cron hitting the same endpoint with
 * `x-sync-secret` restores the schedule with no other change.
 *
 * ---------------------------------------------------------------------------
 * ONE TICKER PER TAB
 *
 * All three Client Health screens mount this through the shared frame and
 * stay mounted, so a module-level count makes sure only the first instance
 * ticks. Three tickers would be harmless — the server is the guard — but a
 * request a minute is the intended cost, not three.
 */

/** Once a minute: the server's slot is fifteen, so a run starts within a minute of coming due. */
const EVERY_MS = 60 * 1000;

/** A small delay on load, so the first tick never competes with first paint. */
const FIRST_RUN_MS = 15 * 1000;

let mounted = 0;

export function SyncScheduler() {
  useEffect(() => {
    mounted += 1;
    if (mounted > 1) {
      return () => { mounted -= 1; };
    }

    let alive = true;
    let inflight = false;

    async function tick() {
      if (inflight || document.visibilityState !== "visible") return;
      inflight = true;
      try {
        await fetch("/api/tools/client-health/sync/tick", {
          method: "POST",
          credentials: "same-origin",
        });
      } catch {
        /*
         * Silent by design. This is the background schedule, not something the
         * reader asked for; the toolbar's "Synced N ago" line is where a
         * schedule that has stopped working becomes visible.
         */
      } finally {
        inflight = false;
      }
    }

    const first = setTimeout(() => { if (alive) void tick(); }, FIRST_RUN_MS);
    const timer = setInterval(tick, EVERY_MS);

    return () => {
      alive = false;
      mounted -= 1;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  return null;
}
