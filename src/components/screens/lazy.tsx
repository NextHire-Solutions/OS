"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Screen data, loaded when the screen is actually opened.
 *
 * ---------------------------------------------------------------------------
 * WHY
 *
 * The workspace renders every screen into every page, so every route used to
 * pay for every screen's data. Each of these loaders feeds exactly ONE screen,
 * and between them they make around eleven upstream HTTP calls:
 *
 *   home overview      5 calls   consumed by Home
 *   performance        2 calls   consumed by Performance
 *   clients roster     4 calls   consumed by Clients
 *
 * Opening /performance therefore waited on the roster's three tools and the
 * home overview's five calls before it could render two numbers. Measured on
 * the live deployment, time to first byte was 1.0–2.5s on pages carrying no
 * data of their own.
 *
 * Now the server loads only the screen being opened — so a pasted link still
 * paints immediately, with no loading state — and the others fetch themselves
 * on first visit. They then stay mounted, so returning is instant.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROMISE IS CACHED, NOT THE RESULT
 *
 * Screens mount together, so several can ask at once. Caching the promise
 * means they share one request; caching the result would still let a second
 * request start before the first landed, which is the usual way this
 * optimisation quietly does nothing.
 *
 * A failure is not cached — it clears so the next visit retries rather than
 * showing the same stale error until a reload.
 */

const inflight = new Map<string, Promise<unknown>>();

export function loadOnce<T>(url: string): Promise<T> {
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;

  const pending = fetch(url, { credentials: "same-origin" })
    .then(async (res) => {
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      return (await res.json()) as T;
    })
    .catch((error) => {
      inflight.delete(url);
      throw error;
    });

  inflight.set(url, pending);
  return pending as Promise<T>;
}

/** Discards a cached load so the next request refetches. */
export function invalidate(url: string): void {
  inflight.delete(url);
}

/**
 * Renders `children` once the data is available.
 *
 * `initial` is set only for the screen the page was opened on. Everything else
 * fetches on mount — but only once mounted, which the shell does lazily, so a
 * screen nobody opens costs nothing at all.
 */
export function Lazy<T>({
  initial,
  url,
  label,
  skeleton,
  children,
}: {
  initial: T | null;
  url: string;
  /** Named in the failure message, so the reader knows what is missing. */
  label: string;
  skeleton?: React.ReactNode;
  children: (data: T) => React.ReactNode;
}) {
  const [data, setData] = useState<T | null>(initial);
  const [error, setError] = useState<string | null>(null);
  // Guards against a state update after unmount during a slow fetch.
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    if (initial) return;
    loadOnce<T>(url).then(
      (d) => { if (live.current) setData(d); },
      (e: unknown) => {
        if (live.current) setError(e instanceof Error ? e.message : `Could not load ${label}`);
      },
    );
  }, [initial, url, label]);

  if (error) {
    return (
      <div className="wrap">
        <div className="anno">
          <b>{label} could not be loaded.</b> {error}
        </div>
      </div>
    );
  }

  if (!data) return <>{skeleton ?? <PlaceholderScreen />}</>;

  return <>{children(data)}</>;
}

/*
 * A neutral placeholder shaped like most screens — cards above, table below —
 * so arriving data does not shove the page around.
 *
 * Deliberately still rather than shimmering: an animation on something that
 * usually resolves in well under a second reads as slower than it is.
 */
export function PlaceholderScreen({ cards = 4 }: { cards?: number }) {
  return (
    <div className="wrap" aria-busy="true">
      <div className="cards" style={{ gridTemplateColumns: `repeat(${cards}, 1fr)` }}>
        {Array.from({ length: cards }, (_, i) => (
          <div className="card" key={i}>
            <div className="card-l"><Bar w={64} /></div>
            <div className="card-n"><Bar w={46} h={26} /></div>
            <div className="card-s"><Bar w={88} /></div>
          </div>
        ))}
      </div>
      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title"><Bar w={132} h={16} /></div>
            <div className="tbl-sub" style={{ marginTop: 6 }}><Bar w={236} /></div>
          </div>
        </div>
        <div style={{ padding: "8px 22px 22px" }}>
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} style={{ padding: "13px 0", borderTop: i ? "1px solid var(--line-soft)" : undefined }}>
              <Bar w={`${54 + ((i * 9) % 30)}%`} h={13} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Bar({ w, h = 11 }: { w: number | string; h?: number }) {
  return (
    <span
      style={{
        display: "block",
        width: w,
        height: h,
        borderRadius: 5,
        background: "var(--inset-2)",
      }}
    />
  );
}
