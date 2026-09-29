/*
 * The rules for a subscription created from the OS — pure, so they are tested
 * without Stripe. See payment-links.ts for the Stripe side.
 */

export type Every = "14 days" | "28 days" | "month";
export const EVERY: Every[] = ["14 days", "28 days", "month"];

/** Stripe's recurring price parameters for each choice. */
export function recurringParams(every: Every): Record<string, string> {
  if (every === "month") return { "recurring[interval]": "month", "recurring[interval_count]": "1" };
  return { "recurring[interval]": "day", "recurring[interval_count]": every === "14 days" ? "14" : "28" };
}

export const MAX_AMOUNT = 100_000;

/** Dollars as typed ("750", "1,500.50", "$750") → cents, or the reason it is not an amount. */
export function parseAmount(input: unknown): { cents: number } | { error: string } {
  const raw = typeof input === "number" ? String(input) : typeof input === "string" ? input : "";
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { error: "Enter the amount in dollars, e.g. 750." };
  const dollars = Number(cleaned);
  if (dollars <= 0) return { error: "The amount must be more than $0." };
  if (dollars > MAX_AMOUNT) return { error: `The amount can be at most $${MAX_AMOUNT.toLocaleString("en-US")}.` };
  return { cents: Math.round(dollars * 100) };
}

export function parseEvery(input: unknown): Every | null {
  return EVERY.includes(input as Every) ? (input as Every) : null;
}

/** "$750 every 14 days" / "$1,500 every month". */
export const describe = (cents: number, every: Every) =>
  `${(cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 ? 2 : 0 })} every ${every}`;

/** A client may get a new subscription when it has none, or its linked one has ended. */
export function canCreate(sub: { status: string } | null): boolean {
  return !sub || sub.status === "canceled" || sub.status === "incomplete_expired";
}
