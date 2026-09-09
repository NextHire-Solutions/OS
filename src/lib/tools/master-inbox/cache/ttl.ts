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

type Entry<T> = { data: T; expiresAt: number; promise?: Promise<T> };

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
  } = {},
): TtlCachedFn<TArgs, TResult> {
  const {
    ttlMs = 30_000,
    inflightTimeoutMs = DEFAULT_INFLIGHT_TIMEOUT_MS,
    key = (...args) => JSON.stringify(args),
  } = options;
  const store = new Map<string, Entry<TResult>>();

  const cached = async (...args: TArgs): Promise<TResult> => {
    const k = key(...args);
    const now = Date.now();
    const hit = store.get(k);
    if (hit && hit.expiresAt > now) return hit.data;
    if (hit?.promise) return hit.promise;

    const promise = fn(...args).then(
      (data) => {
        store.set(k, { data, expiresAt: Date.now() + ttlMs });
        return data;
      },
      (err) => {
        store.delete(k);
        throw err;
      },
    );
    store.set(k, { data: hit?.data as TResult, expiresAt: 0, promise });

    // Watchdog: clear the in-flight entry if it hasn't resolved within
    // inflightTimeoutMs, so the next caller fires a fresh request
    // instead of awaiting a stuck promise forever.
    const watchdog = setTimeout(() => {
      const current = store.get(k);
      if (current?.promise === promise) store.delete(k);
    }, inflightTimeoutMs);
    promise.finally(() => clearTimeout(watchdog));

    return promise;
  };

  // Cache-bust API. Mutation endpoints call this after writing so the
  // next read sees the update instead of waiting for the TTL window.
  // No args = drop every entry (useful when the cache key has varying
  // shape and the caller doesn't care which slot to drop).
  (cached as TtlCachedFn<TArgs, TResult>).invalidate = (...args: Partial<TArgs>) => {
    if (args.length === 0) {
      store.clear();
      return;
    }
    store.delete(key(...(args as TArgs)));
  };

  return cached as TtlCachedFn<TArgs, TResult>;
}
