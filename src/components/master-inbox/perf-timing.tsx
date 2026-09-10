"use client";

import { useEffect } from "react";

// Reads the click-time stamp the thread-list set when the user clicked
// this thread's row and prints the total click-to-render delta to the
// browser console. Use the DevTools console to read these numbers.
//
// Tagged with the threadId so you can compare specific switches if
// repeating the same action. Cleared after reading so a refresh doesn't
// re-log stale data.
export function ClickRenderTiming({ threadId }: { threadId: string }) {
  useEffect(() => {
    try {
      const t0 = sessionStorage.getItem("mi:lastClickAt");
      const target = sessionStorage.getItem("mi:lastClickTarget");
      if (!t0 || target !== threadId) return;
      sessionStorage.removeItem("mi:lastClickAt");
      sessionStorage.removeItem("mi:lastClickTarget");
      const dt = Math.round(performance.now() - Number(t0));
      // eslint-disable-next-line no-console
      console.log(
        `%c[perf] click → render: ${dt}ms  (thread ${threadId.slice(0, 8)})`,
        "color: #6366f1; font-weight: 600",
      );
    } catch {
      /* sessionStorage unavailable */
    }
  }, [threadId]);
  return null;
}
