"use client";

import { useEffect, useState } from "react";

import { describeSync, runSync } from "./actions";
import { refreshClientHealth } from "./load";

/*
 * "Sync now" — the same button Client Health's own dashboard has.
 *
 * It triggers that tool's sync worker rather than doing anything itself, so
 * whatever the tool does today, this does. See the sync API route.
 *
 * Three things this gets right that a naive version would not:
 *
 *   it stays disabled while running. The sync walks thousands of campaigns; a
 *   second press would start a second full sweep against the same upstreams.
 *
 *   it reloads the workspace's copy afterwards. Otherwise the sync succeeds
 *   and the screen still shows the old numbers, which reads as a failure.
 *
 *   a timeout says the sync is STILL RUNNING, because it is. Telling somebody
 *   their sync failed when it merely outlived the request is how you get three
 *   concurrent syncs.
 */
export function SyncButton({ onDone }: { onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.bad ? 8000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  async function sync() {
    setBusy(true);
    setToast(null);
    try {
      const result = await runSync();
      // The tool has new numbers; ours are now stale by definition.
      await refreshClientHealth();
      onDone?.();
      setToast({ text: describeSync(result) });
    } catch (error) {
      setToast({
        text: error instanceof Error ? error.message : "Sync failed",
        bad: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="btn btn-pri"
        onClick={sync}
        disabled={busy}
        aria-busy={busy}
        title={
          busy
            ? "Syncing — this walks every campaign on Instantly and EmailBison"
            : "Pull the latest from Instantly, EmailBison and Master Inbox"
        }
        style={busy ? { opacity: 0.65, cursor: "progress" } : undefined}
      >
        {busy ? "Syncing…" : "Sync now"}
      </button>

      {toast ? (
        <div
          role="status"
          style={{
            position: "fixed",
            right: 22,
            bottom: 22,
            zIndex: 60,
            maxWidth: 460,
            padding: "12px 16px",
            borderRadius: 12,
            fontSize: 13.5,
            lineHeight: 1.5,
            color: "#fff",
            background: toast.bad ? "var(--red)" : "var(--ink)",
            boxShadow: "0 10px 34px rgba(16,20,28,.24)",
          }}
        >
          {toast.text}
        </div>
      ) : null}
    </>
  );
}
