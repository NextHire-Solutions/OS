"use client";

import { useEffect, useRef } from "react";

/*
 * Keeps the sign-in alive while the workspace is open.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS FIXES
 *
 * The sign-in cookie lives 30 minutes. That is deliberate and worth keeping —
 * it is the revocation window, and the reason removing somebody's access
 * reaches four apps that never touch a database.
 *
 * But `/api/auth/refresh` existed and NOTHING EVER CALLED IT. A comment in the
 * proxy said "the client posts to /api/auth/refresh"; no client did. So every
 * session died after half an hour, mid-task, and the next click bounced to the
 * login page. It caught my own test run, which is how it was found — half an
 * hour is long enough that nobody hits it while checking a change, and short
 * enough that everybody hits it while working.
 *
 * ---------------------------------------------------------------------------
 * WHY IT REFRESHES WHEN IT DOES
 *
 *   every 10 minutes — comfortably inside the 30-minute window, so two
 *   consecutive failures still leave time to recover before expiry.
 *
 *   whenever the tab is shown again — a laptop that slept through lunch has a
 *   dead token, and the alternative is discovering that by clicking something
 *   and being thrown to the login page.
 *
 *   NOT on every interaction. The point of a short token is that it expires;
 *   refreshing on activity alone would keep a revoked account alive as long as
 *   somebody kept typing.
 *
 * A 401 means the session is genuinely gone — expired, revoked, or the account
 * deactivated. The reader is sent to sign in again, carrying where they were
 * so they land back on the same screen rather than at Home.
 */

/** Comfortably inside the 30-minute token life. */
const EVERY_MS = 10 * 60 * 1000;

/** Ignore a visibility refresh if one just ran — tab switching is frequent. */
const MIN_GAP_MS = 60 * 1000;

export function SessionKeeper() {
  const last = useRef(0);
  const running = useRef(false);

  useEffect(() => {
    let alive = true;

    async function refresh() {
      // Overlapping refreshes would race to set the same cookie.
      if (running.current) return;
      const now = Date.now();
      if (now - last.current < MIN_GAP_MS) return;
      running.current = true;
      last.current = now;

      try {
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          credentials: "same-origin",
        });

        if (res.status === 401 && alive) {
          // Genuinely signed out. Carry the current location so signing in
          // returns the reader to the screen they were on.
          const next = `${window.location.pathname}${window.location.search}`;
          window.location.href = `/login?next=${encodeURIComponent(next)}`;
        }
      } catch {
        /*
         * A network failure is not a signed-out session — a flaky connection or
         * a deploy rolling over would both land here. Staying put and trying
         * again on the next tick is right; bouncing to the login page would
         * throw away whatever the reader was in the middle of.
         */
      } finally {
        running.current = false;
      }
    }

    const timer = setInterval(refresh, EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
