"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Destination } from "@/lib/workspace/nav";

/*
 * ⌘K — the answer to "where can I go?".
 *
 * Indexed from the same navigation tree the rail renders, so the two can never
 * drift: a destination added to one appears in the other for free.
 *
 * Matching is subsequence, not substring, so "cliweek" finds Client Health ›
 * Weekly. People type the shape of a thing, not its prefix.
 */

export function Palette({
  open,
  destinations,
  onClose,
  onPick,
}: {
  open: boolean;
  destinations: Destination[];
  onClose: () => void;
  onPick: (d: Destination) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return destinations;
    return destinations.filter((d) => {
      const key = `${d.label} ${d.group}`.toLowerCase();
      let i = 0;
      for (const ch of q) {
        if (ch === " ") continue;
        i = key.indexOf(ch, i);
        if (i < 0) return false;
        i++;
      }
      return true;
    });
  }, [query, destinations]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => setSelected(0), [query]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[selected] as HTMLElement | undefined;
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 6;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 6;
    }
  }, [selected]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((s) => (hits.length ? (s + 1) % hits.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((s) => (hits.length ? (s - 1 + hits.length) % hits.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = hits[selected];
      if (hit) onPick(hit);
    } else if (event.key === "Tab") {
      // Focus stays inside the dialog.
      event.preventDefault();
    }
  }

  return (
    <>
      <div className={`scrim${open ? " on" : ""}`} onClick={onClose} />
      <div
        className={`cmdk${open ? " on" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Jump to a screen"
        onKeyDown={onKeyDown}
      >
        <div className="cmdk-in">
          <svg viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7.5" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search or jump to…"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="cmdk-list" ref={listRef} role="listbox" aria-label="Screens">
          {hits.length === 0 ? (
            <div className="cmdk-empty">Nothing matches that.</div>
          ) : (
            hits.slice(0, 40).map((d, i) => (
              <button
                key={d.id}
                type="button"
                className="cmdk-row"
                role="option"
                aria-selected={i === selected}
                onMouseMove={() => setSelected(i)}
                onClick={() => onPick(d)}
              >
                <span className="cd" />
                <span>{d.label}</span>
                <span className="cg">{d.group}</span>
              </button>
            ))
          )}
        </div>

        <div className="cmdk-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↩</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </>
  );
}
