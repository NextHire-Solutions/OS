/*
 * Typed, lazy env access.
 *
 * `required()` throws at CALL time, never at import time. That distinction is
 * the whole point: a missing CLIENT_HEALTH_READ_TOKEN must degrade one card to
 * "unconfigured", not crash the process and take the other four down with it.
 */

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export class NotConfiguredError extends Error {
  // Assigned explicitly rather than via a constructor parameter property.
  // Parameter properties are TypeScript-only sugar that Node's type-stripping
  // cannot remove, so `node --test` — this project's test runner — refuses to
  // import any file that reaches this one. Two extra lines buys testability.
  readonly varName: string;

  constructor(varName: string) {
    super(`${varName} is not set`);
    this.name = "NotConfiguredError";
    this.varName = varName;
  }
}

/**
 * The upstream cannot serve this over HTTP at all — no credential would help.
 *
 * A third category, distinct from "we have no token" and from "it broke",
 * because conflating it with the latter makes the status colour meaningless.
 *
 * The case that forced it: Master Inbox's /api/admin/thread-counts gets past
 * that app's proxy with a service-role token, then its handler calls
 * requireSession(), which has no service-role path and redirects to /login. No
 * token we hold can ever satisfy it. Reporting that as a fault marks the tool
 * degraded permanently, for a metric that has never been readable — and a
 * dashboard that is always amber is a dashboard nobody reads.
 *
 * So: the tool is healthy, one number is simply not available. Info, not warn.
 */
export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedError";
  }
}

export function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new NotConfiguredError(name);
  return value;
}

/** Base URL with any trailing slash removed, so `${base}${path}` is always right. */
export function baseUrlEnv(name: string): string {
  return requiredEnv(name).replace(/\/+$/, "");
}

export function isConfigured(...names: string[]): boolean {
  return names.every((n) => Boolean(optionalEnv(n)));
}

/*
 * ---------------------------------------------------------------------------
 * Master Inbox compatibility re-exports.
 *
 * The copied Master Inbox code reads `env.INSTANTLY_API_KEY` and friends from
 * `@/lib/env`. In the OS those same variables are namespaced
 * (`MASTER_INBOX_INSTANTLY_API_KEY`) so five tools can share one environment
 * without colliding; the namespacing itself lives in the real module, which
 * builds each name at lookup time.
 *
 * These two lines exist so the copied files keep the import they already have.
 * They are APPENDED to this module rather than replacing it — the OS's own
 * `optionalEnv` / `NotConfiguredError` above are used by Client Health and the
 * catch-all route, and overwriting them broke both.
 */
export { env, browserEnv } from "./tools/master-inbox/env.ts";
