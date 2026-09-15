"use client";

import { addDays, formatWeek, getMondayOf, weekKey } from "@/lib/tools/client-health/derive";
import type { SyncHealth } from "@/lib/tools/client-health/sync/health";
import { humanizeAgo } from "@/lib/tools/client-health/views";
import type { ClientHealthWeeklyData } from "@/lib/tools/client-health/weekly";

import { SyncButton } from "./sync-button";
import { setWeekOffset, useClientHealthView } from "./view-state";

/*
 * The controls the tool keeps in its header, on every view: ← / This Week / →,
 * Today when you have stepped back, + Add Client, and the sync. Plus the
 * past-week banner the tool shows under the header whenever the selected
 * week is not the current one.
 *
 * One component so the three screens cannot drift — a Bi-Weekly that lacked
 * the arrows silently always showed this week, whatever Weekly was showing.
 */

export interface SelectedWeek {
  /** The Monday of the selected week, as YYYY-MM-DD. */
  key: string;
  isCurrent: boolean;
  offset: number;
}

/**
 * The week on screen, measured from the SERVER's week so offset 0 reproduces
 * the server render exactly and hydration never mismatches across a Monday.
 */
export function useSelectedWeek(data: ClientHealthWeeklyData): SelectedWeek {
  const { weekOffset } = useClientHealthView();
  const key =
    weekOffset === 0 ? data.weekKey : weekKey(addDays(`${data.weekKey}T00:00:00`, weekOffset * 7));
  return { key, isCurrent: weekOffset === 0, offset: weekOffset };
}

export function weekLabel(key: string): string {
  return formatWeek(getMondayOf(`${key}T00:00:00`));
}

export function ClientHealthToolbar({
  week, onAdd, sync, now,
}: {
  week: SelectedWeek;
  onAdd: () => void;
  /** From the data payload; null when sync_runs could not be read. */
  sync?: SyncHealth | null;
  /** The server's clock, so the "ago" text hydrates identically. */
  now?: Date;
}) {
  const { isCurrent, key } = week;
  return (
    <>
      {/* A past week is a record, not a dashboard. Said plainly, because the
          rest of the screen looks exactly the same and the numbers do not. */}
      {!isCurrent ? (
        <div className="anno">
          <b>Viewing a past week.</b> These figures are a record of that week — the row
          actions and the sync still act on today.
        </div>
      ) : null}

      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 10, marginBottom: 18, flexWrap: "wrap",
        }}
      >
        <span className="pills" style={{ padding: 0 }}>
          <button className="fp" onClick={() => setWeekOffset((o) => o - 1)} aria-label="Previous week" title="Previous week">←</button>
          <button
            className={`fp${isCurrent ? " on" : ""}`}
            style={{ minWidth: 150 }}
            onClick={() => setWeekOffset(0)}
            // Highlighted only on the current week, so the rail reads as "you
            // are looking at something else" the moment you step back.
            aria-label="Selected week"
            title={isCurrent ? "Showing this week" : "Back to this week"}
          >
            {isCurrent ? "This Week" : weekLabel(key)}
          </button>
          <button
            className="fp"
            onClick={() => setWeekOffset((o) => o + 1)}
            disabled={isCurrent}
            aria-label="Next week"
            title={isCurrent ? "This is the current week" : "Next week"}
            style={isCurrent ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
          >
            →
          </button>
        </span>

        {!isCurrent ? (
          <button className="btn" onClick={() => setWeekOffset(0)} title="Back to the current week">
            Today
          </button>
        ) : null}

        <button className="btn" onClick={onAdd}>+ Add Client</button>
        {sync ? <SyncStatus sync={sync} now={now} /> : null}
        <SyncButton />
      </div>
    </>
  );
}

/*
 * "Synced 5 min ago" — when the sync last completed, next to the button that
 * runs it.
 *
 * The tool has no such line: its dashboard trusted the cron and showed only a
 * ↻ button and a "Synced · N campaigns" toast. The wording and the relative
 * time are its own `humanizeAgo` — the helper it wrote for the Client Success
 * table's Portal Updated cell and documented as being for `portal_synced_at`
 * too — so the cadence reads the same as the rest of the screen. Needed now
 * because the schedule depends on a tab being open: numbers that are hours
 * old must say so where the reader is looking.
 *
 * Amber when the last run failed, or when nothing has succeeded in an hour
 * (four missed quarter-hour slots — see sync/health.ts). Never red: this is
 * staleness, not an outage, and the reader can press the button.
 */
function SyncStatus({ sync, now }: { sync: SyncHealth; now?: Date }) {
  const at = now ? now.getTime() : Date.now();
  const failed = sync.errors.length > 0;
  const attention = failed || sync.stale;
  const text = sync.running
    ? "Syncing…"
    : sync.lastSuccessAt
      ? `Synced ${humanizeAgo(sync.lastSuccessAt, at)}`
      : "Never synced";
  const title = [
    sync.lastStartedAt ? `Last run started ${humanizeAgo(sync.lastStartedAt, at)}` : "No run recorded",
    ...sync.sources.map((s) =>
      `${s.source}: ${s.lastSuccessAt ? `ok ${humanizeAgo(s.lastSuccessAt, at)}` : "no success recorded"}${s.lastError ? ` · failed: ${s.lastError}` : ""}`,
    ),
  ].join("\n");
  return (
    <span
      className="tbl-sub"
      title={title}
      aria-live="polite"
      style={{
        fontSize: 12.5,
        whiteSpace: "nowrap",
        color: attention ? "var(--amber, #b7791f)" : undefined,
      }}
    >
      {text}
      {failed ? " · last run failed" : ""}
    </span>
  );
}
