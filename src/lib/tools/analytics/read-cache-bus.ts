/*
 * "The Analytics numbers just changed."
 *
 * The sync runner says so when a job lands; the cached reads (cached-get.ts)
 * listen and drop what they hold, so a finished sync shows at once instead of
 * up to a minute later. Deliberately import-free, so the runner and its tests
 * do not pull in the server-only cache.
 */
const listeners = new Set<() => void>();

export function onAnalyticsDataChanged(fn: () => void): void {
  listeners.add(fn);
}

export function analyticsDataChanged(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* a listener never breaks a sync */ }
  }
}
