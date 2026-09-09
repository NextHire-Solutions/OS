"use client";

import { useEffect, useRef } from "react";

/*
 * Retries introduction side effects that a lost process left behind.
 *
 * ---------------------------------------------------------------------------
 * WHY IT RUNS FROM THE BROWSER
 *
 * The outbox needs something to sweep it. The obvious answer is a cron, and
 * the workspace has no cron service — adding one to Railway means either a new
 * service or a schedule on the web service, and the latter restarts the thing
 * it is meant to protect.
 *
 * So the sweep is triggered by whoever has the workspace open. That sounds
 * flimsy and is not, once you look at when the failure actually happens: a job
 * is lost when the server restarts, which is a deploy, which happens while
 * somebody is working. The retry lands within a couple of minutes.
 *
 * What it does NOT cover is a job lost at 3am with nobody signed in. That waits
 * until morning. Given the alternative today is losing it forever, that is a
 * trade worth taking — and if it ever matters, this becomes a Railway cron
 * hitting the same endpoint, with no other change.
 *
 * ---------------------------------------------------------------------------
 * WHY CONCURRENT BROWSERS ARE SAFE
 *
 * Every open tab sweeps. The server claims a batch before working it and
 * treats a claim younger than five minutes as taken, so two tabs cannot both
 * send the same Slack notice. The guard is server-side on purpose: a rule that
 * only holds while exactly one tab is open is not a guard.
 */

/** Often enough that a lost job is retried while somebody is still working. */
const EVERY_MS = 2 * 60 * 1000;

/** A small delay on load, so the sweep never competes with first paint. */
const FIRST_RUN_MS = 20 * 1000;

export function OutboxSweeper() {
  const running = useRef(false);

  useEffect(() => {
    let alive = true;

    async function sweep() {
      if (running.current || document.visibilityState !== "visible") return;
      running.current = true;
      try {
        await fetch("/api/tools/master-inbox/outbox", {
          method: "POST",
          credentials: "same-origin",
        });
      } catch {
        /*
         * Silent by design. This is background repair, not something the
         * reader asked for — surfacing a failed sweep would be interrupting
         * somebody about a problem they cannot act on. The endpoint records
         * its own errors, and the health figures show them.
         */
      } finally {
        running.current = false;
      }
    }

    const first = setTimeout(() => { if (alive) void sweep(); }, FIRST_RUN_MS);
    const timer = setInterval(sweep, EVERY_MS);

    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  return null;
}
