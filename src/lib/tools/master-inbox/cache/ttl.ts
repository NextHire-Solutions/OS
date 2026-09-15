// Module-level TTL cache wrapper.
//
// React.cache() dedupes calls within a single render. ttlCache() dedupes
// across renders for `ttlMs` milliseconds, by keying on the function
// arguments. Use it on loaders whose data changes infrequently (labels,
// channels, clients, campaigns, lists, views) so concurrent users hitting
// the same workspace don't each re-fetch the same lookup tables.
//
// Compose with React.cache() like:
//   export const loadX = cache(ttlCache(_loadX, { ttlMs: 30_000 }));
//
// Safety: cache key includes every argument, so workspace isolation works
// out of the box. Only wrap loaders whose result is identical for every
// caller with the same arguments (i.e. workspace-wide data, not
// per-user-filtered data).
//
// In-flight dedup includes a watchdog timeout (`inflightTimeoutMs`) — if
// the underlying fetch hangs (stuck socket, dropped connection) the
// in-flight entry is cleared so the NEXT caller fires a fresh request
// instead of awaiting a promise that never resolves. Without this,
// a single hung request would poison the cache indefinitely.

type Entry<T> = { data: T; expiresAt: number; staleUntil?: number; promise?: Promise<T> };

const DEFAULT_INFLIGHT_TIMEOUT_MS = 12_000;

// Returned function carries an `.invalidate()` method so mutation
// endpoints can bust the cache immediately after writing — needed
// for any list whose order or membership changes via user action
// (e.g. drag-reorder of views) where the next read MUST reflect
// the write rather than serve a stale 30s window.
export interface TtlCachedFn<TArgs extends unknown[], TResult> {
  (...args: TArgs): Promise<TResult>;
  /** Drop the cache entry for these args. Pass no args to drop ALL. */
  invalidate(...args: Partial<TArgs>): void;
}

export function ttlCache<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: {
    ttlMs?: number;
    inflightTimeoutMs?: number;
    key?: (...args: TArgs) => string;
    /*
     * Stale-while-revalidate. For this long AFTER the TTL, a caller gets the
     * previous result immediately and the refresh runs in the background.
     *
     * Why: Open Responses is a 12-second computation cached for 60s. Anyone
     * who opened it more than a minute after the last person waited the full
     * 12s — measured cold at 13.1s on production, 1.1s warm — and the same
     * shape made Portals a 4.2s cold load. With this, only the very first
     * request after a deploy pays; everyone after gets the last answer at
     * once and a fresh one a moment later. The bound is explicit per loader:
     * a served value is never older than ttlMs + staleMs.
     */
    staleMs?: number;
  } = {},
): TtlCachedFn<TArgs, TResult> {
  const {
    ttlMs = 30_000,
    inflightTimeoutMs = DEFAULT_INFLIGHT_TIMEOUT_MS,
    key = (...args) => JSON.stringify(args),
    staleMs = 0,
  } = options;
  const store = new Map<string, Entry<TResult>>();

  const refresh = (k: string, args: TArgs, previous: TResult | undefined, staleUntil: number | undefined): Promise<TResult> => {
    const promise = fn(...args).then(
      (data) => {
        const now = Date.now();
        store.set(k, { data, expiresAt: now + ttlMs, staleUntil: now + ttlMs + staleMs });
        return data;
      },
      (err) => {
        // A failed refresh keeps nothing new. A stale value that was being
        // served stays servable for its window rather than becoming an error.
        const current = store.get(k);
        if (current?.promise === promise) {
          if (previous !== undefined && staleMs > 0 && (staleUntil ?? 0) > Date.now()) {
            store.set(k, { data: previous, expiresAt: 0, staleUntil });
          } else {
            store.delete(k);
          }
        }
        throw err;
      },
    );
    store.set(k, { data: previous as TResult, expiresAt: 0, staleUntil, promise });

    const watchdog = setTimeout(() => {
      const current = store.get(k);
      if (current?.promise === promise) store.delete(k);
    }, inflightTimeoutMs);
    // then/then, not finally: `.finally` returns a derived promise that
    // rejects alongside the original, and a background refresh has nobody
    // awaiting that derived one — it surfaced as an unhandled rejection.
    promise.then(() => clearTimeout(watchdog), () => clearTimeout(watchdog));

    return promise;
  };

  const cached = async (...args: TArgs): Promise<TResult> => {
    const k = key(...args);
    const now = Date.now();
    const hit = store.get(k);
    if (hit && hit.expiresAt > now) return hit.data;
    const servable = !!hit && staleMs > 0 && hit.data !== undefined && (hit.staleUntil ?? 0) > now;
    if (hit?.promise) {
      // A refresh is already running: hand back the stale value if it is
      // still within bounds, otherwise wait for the refresh like everyone.
      return servable ? hit.data : hit.promise;
    }
    if (servable) {
      // Expired, within the stale window: answer now, refresh behind.
      refresh(k, args, hit.data, hit.staleUntil).catch(() => {});
      return hit.data;
    }
    return refresh(k, args, hit?.data, hit?.staleUntil);
  };

  (cached as TtlCachedFn<TArgs, TResult>).invalidate = (...args: Partial<TArgs>) => {
    if (args.length === 0) {
      store.clear();
      return;
    }
    store.delete(key(...(args as TArgs)));
  };

  return cached as TtlCachedFn<TArgs, TResult>;
}
