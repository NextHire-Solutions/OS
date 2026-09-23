/*
 * A client's status, and nothing else.
 *
 * Pure and dependency-free because both sides need it: `os-clients.ts` is
 * `server-only` (it holds a database connection), and the Clients screen is a
 * client component. Importing the server module into the browser bundle fails
 * at build with an error that points at the import rather than the cause, so
 * the shared vocabulary lives here instead.
 *
 * There is no "deleted". A client that stops trading is `churned` and can be
 * `active` again — every value here is reachable from every other one, which
 * is the whole business rule.
 */
/*
 * In lifecycle order, because this array is what the status dropdown renders:
 * a client is onboarded, becomes active, may pause, may churn — and can come
 * back to active from either of the last two.
 *
 * 'prospect' was the old word for 'onboarding'. Migration 0012 normalised
 * every row to the new word and 0013 removes the old one from the database's
 * own constraint; it is gone from here so nothing can write it again.
 */
export const CLIENT_STATUSES = ["onboarding", "active", "paused", "churned"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export function isClientStatus(value: unknown): value is ClientStatus {
  return typeof value === "string" && (CLIENT_STATUSES as readonly string[]).includes(value);
}

export function statusLabel(status: ClientStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
