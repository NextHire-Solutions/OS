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

/*
 * ONE VISUAL LANGUAGE FOR STATUS, defined once (architecture spec §11).
 *
 * The spec asks that status names, colours, badges, filters and terminology be
 * the same everywhere, and fixes two of the four colours itself:
 *
 *     Onboarding -> standardized onboarding indicator
 *     Active     -> standardized active indicator
 *     Paused     -> orange
 *     Churned    -> red
 *
 * Paused and churned are therefore not ours to choose. Active takes green,
 * which it already had. Onboarding takes blue — deliberately NOT a shade of
 * the other three, because it is the one state that is neither running nor
 * stopped, and a paler orange would read as "nearly paused".
 *
 * The reason this lives here rather than in a stylesheet: OS renders status in
 * several screens, and the previous arrangement gave active one class and
 * every other state the SAME yellow one — so paused and churned were
 * indistinguishable at a glance, which is the exact complaint §11 opens with.
 * A single map means a new surface cannot quietly invent a fifth treatment.
 *
 * Kept dependency-free alongside the vocabulary for the same reason: both the
 * server modules and the client components need it.
 */
export const STATUS_TONE: Record<ClientStatus, string> = {
  onboarding: "s-onboarding",
  active: "s-active",
  paused: "s-paused",
  churned: "s-churned",
};

/** The CSS custom property holding this status's foreground colour. */
export const STATUS_COLOR_VAR: Record<ClientStatus, string> = {
  onboarding: "var(--blue-ink)",
  active: "var(--green)",
  paused: "var(--yellow)",
  churned: "var(--red)",
};

/**
 * One sentence per status, as §9 defines them. Used as the badge's tooltip so
 * the meaning is available wherever the status is shown, rather than only to
 * whoever has read the spec.
 */
export const STATUS_MEANING: Record<ClientStatus, string> = {
  onboarding: "Created and going through the onboarding process.",
  active: "Currently active and receiving the service.",
  paused: "Temporarily paused, but still a client.",
  churned: "No longer an active client.",
};
