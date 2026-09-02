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
  constructor(public readonly varName: string) {
    super(`${varName} is not set`);
    this.name = "NotConfiguredError";
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
