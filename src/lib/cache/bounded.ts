/*
 * A small cache with a size limit (13 Nov). ttl.ts keeps every key it has seen until that key is asked for again —
 * right for a few fixed keys, wrong for one key per search, where it only grows. This one keeps the newest `max`
 * answers, each for `ttlMs`; one read at a time per key (a second caller shares the first's); a failure is never kept,
 * nor an answer `keep` turns down. Shared across Next's copies of a module by name, as ttl.ts's `shared` store is.
 */

interface Held<T> {
  at: number;
  value: Promise<T>;
}

export interface BoundedCache<T> {
  /** The answer kept for `key`, or `read()`'s, kept for next time. */
  get(key: string, read: () => Promise<T>): Promise<T>;
  /** Forgets every key that starts with `prefix`. */
  forget(prefix: string): void;
  /** How many answers are kept. */
  size(): number;
}

export function boundedCache<T>(name: string, o: { ttlMs: number; max: number; keep?: (value: T) => boolean; now?: () => number }): BoundedCache<T> {
  const g = globalThis as { __boundedCaches?: Record<string, Map<string, Held<unknown>>> };
  const all = (g.__boundedCaches ??= {});
  const store = (all[name] ??= new Map()) as Map<string, Held<T>>;
  const now = o.now ?? Date.now;
  const drop = (key: string, value: Promise<T>) => {
    if (store.get(key)?.value === value) store.delete(key);
  };
  return {
    get(key, read) {
      const at = now();
      const hit = store.get(key);
      if (hit && at - hit.at < o.ttlMs) return hit.value;
      const value = read();
      // Newest last, so the oldest is the first to go.
      store.delete(key);
      store.set(key, { at, value });
      while (store.size > o.max) store.delete(store.keys().next().value as string);
      value.then((v) => { if (o.keep && !o.keep(v)) drop(key, value); }, () => drop(key, value));
      return value;
    },
    forget(prefix) {
      for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
    },
    size: () => store.size,
  };
}
