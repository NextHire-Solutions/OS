"use client";

import { useState } from "react";

import { setSeen, setStatus, type ThreadStatus } from "./actions";

/*
 * The design's `.mi-selbar` — paging, and what to do with a selection.
 *
 * It is one bar with two jobs on purpose, because that is how the design draws
 * it: with nothing ticked it shows where you are in the list; with rows ticked
 * it becomes the bulk toolbar. Two stacked bars would push the first row of
 * mail further down the screen for no gain.
 *
 * Every action here moves threads OUT of the view being looked at, so each one
 * says how many it will affect, and the whole bar disables while a write is in
 * flight — a second click on "Trash" would move threads somebody has already
 * moved, and the second batch might not be the same batch.
 */
export function SelectionBar({
  selected, total, page, lastPage, pageSize, onClear, onSelectAll, onDone, onPage,
}: {
  selected: string[];
  total: number;
  page: number;
  lastPage: number;
  pageSize: number;
  onClear: () => void;
  onSelectAll: () => void;
  onDone: () => void;
  onPage: (delta: number) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const n = selected.length;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  async function run(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setFailed(null);
    try {
      await fn();
      onDone();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "That did not work");
    } finally {
      setBusy(null);
    }
  }

  const move = (status: ThreadStatus, label: string) =>
    run(label, () => setStatus(selected, status));

  return (
    <div className="mi-selbar">
      <span
        className="cbx"
        role="checkbox"
        aria-checked={n > 0}
        aria-label={n > 0 ? "Clear selection" : "Select every conversation on this page"}
        onClick={n > 0 ? onClear : onSelectAll}
        style={{
          cursor: "pointer",
          ...(n > 0 ? { background: "var(--blue)", borderColor: "var(--blue)" } : {}),
        }}
      />

      {n === 0 ? (
        <span className="tnum">
          {from.toLocaleString("en-US")}–{to.toLocaleString("en-US")} of{" "}
          {total.toLocaleString("en-US")}
        </span>
      ) : (
        <>
          <span className="tnum">
            {n} selected
          </span>
          {/* Each says what it will do to how many — a bulk action that reads
              "Archive" gives no sense of scale before it is pressed. */}
          <button className="fp" disabled={busy !== null} onClick={() => move("archived", "archive")}
            title={`Archive ${n} conversation${n === 1 ? "" : "s"}`}>
            {busy === "archive" ? "…" : "Archive"}
          </button>
          <button className="fp" disabled={busy !== null} onClick={() => move("spam", "spam")}
            title={`Mark ${n} as spam`}>
            {busy === "spam" ? "…" : "Spam"}
          </button>
          <button className="fp" disabled={busy !== null} onClick={() => move("trash", "trash")}
            title={`Move ${n} to trash — recoverable from the Trash view`}>
            {busy === "trash" ? "…" : "Trash"}
          </button>
          <button className="fp" disabled={busy !== null} onClick={() => run("read", () => setSeen(selected, true))}
            title={`Mark ${n} as read`}>
            {busy === "read" ? "…" : "Read"}
          </button>
          <button className="fp" disabled={busy !== null} onClick={() => run("unread", () => setSeen(selected, false))}
            title={`Mark ${n} as unread`}>
            {busy === "unread" ? "…" : "Unread"}
          </button>
          {failed ? (
            <span className="lc lc-red" title={failed}>{failed.slice(0, 40)}</span>
          ) : null}
        </>
      )}

      <span className="spacer" style={{ flex: 1 }} />

      {lastPage > 1 ? (
        <>
          <span className="tnum">Page {page} / {lastPage.toLocaleString("en-US")}</span>
          <button className="ib" onClick={() => onPage(-1)} disabled={page <= 1} aria-label="Previous page">
            <svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <button className="ib" onClick={() => onPage(1)} disabled={page >= lastPage} aria-label="Next page">
            <svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </>
      ) : null}
    </div>
  );
}
