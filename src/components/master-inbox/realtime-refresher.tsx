"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/*
 * Keeps the inbox current without the user pressing reload.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A POLL HERE AND A WEBSOCKET IN THE TOOL
 *
 * The tool subscribes to Supabase Realtime. That works there because the
 * browser holds a real Supabase session: `postgres_changes` is filtered by the
 * same RLS policies as a query, and those policies resolve
 * `is_workspace_member(workspace_id)` through `auth.uid()`.
 *
 * The OS reads through a service-role client on the server; the browser has no
 * Supabase session at all. Subscribing with the anon key would connect,
 * subscribe, report SUBSCRIBED — and then deliver zero events forever, because
 * anon is a member of no workspace. That is the worst kind of failure: it looks
 * like it is working.
 *
 * So the transport changes and the feature does not. The tool's own code
 * already carries a 30-second poll as its stated safety net for exactly this
 * ("Supabase Realtime has known JWT-timing / reconnection edge cases — the poll
 * guarantees the user never has to hit refresh manually"). Here that net is the
 * whole mechanism.
 *
 * Two behaviours are preserved verbatim from the tool, both of which were bugs
 * once:
 *
 *   PAUSE WHILE HIDDEN. A background tab has nobody looking at it, and twenty
 *   open tabs would otherwise poll the server forever.
 *
 *   NEVER REFRESH ON A `threads` UPDATE. Opening a thread writes `seen=true`,
 *   and refreshing on that races the in-flight navigation and cancels it — the
 *   "click another thread, the dot clears, the page doesn't change" bug.
 *   Polling cannot reintroduce it, but the constraint is recorded because any
 *   future realtime work here has to respect it.
 */

const POLL_MS = 30_000;

export function RealtimeRefresher({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function tick() {
      if (typeof document !== "undefined" && document.hidden) return;
      router.refresh();
    }

    timer.current = setInterval(tick, POLL_MS);

    // Returning to a tab that sat idle should not wait out the rest of the
    // interval — that is precisely when the list is most likely to be stale.
    function onVisible() {
      if (typeof document !== "undefined" && !document.hidden) router.refresh();
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      if (timer.current) clearInterval(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [workspaceId, router]);

  return null;
}
