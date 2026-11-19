/*
 * Which campaigns Duplicate & Renew can take, by status alone — known on the
 * Campaigns list and a campaign's page without asking anything, so the button
 * is greyed out with the reason straight away (user, 19 Nov: "show if we cannot
 * duplicate and renew any campaign little faster"). The review repeats the
 * check on EmailBison's live status.
 *
 * Pure, and free of Node imports: the screens import it.
 */

/** Running, paused part-way, or finished. */
export const RENEWABLE_STATUSES: ReadonlySet<string> = new Set(["active", "paused", "completed"]);

const norm = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();

export function canRenewStatus(status: string | null | undefined): boolean {
  return RENEWABLE_STATUSES.has(norm(status));
}

/** The review's sentence for a status that cannot be renewed; null when it can. */
export function statusRefusal(status: string | null | undefined): string | null {
  const s = norm(status);
  if (RENEWABLE_STATUSES.has(s)) return null;
  if (s === "draft") return "This campaign is a draft: it has not started, so there is nothing to renew. Use Duplicate instead.";
  return `This campaign is ${s || "in an unknown state"}. Only a running, paused or finished campaign can be renewed.`;
}

/** The greyed-out button's tooltip; null when it can be renewed. */
export function statusRefusalShort(status: string | null | undefined): string | null {
  const s = norm(status);
  if (RENEWABLE_STATUSES.has(s)) return null;
  if (s === "draft") return "A draft has not started, so there is nothing to renew";
  return `A campaign that is ${s || "in an unknown state"} cannot be renewed (only running, paused or finished ones)`;
}
