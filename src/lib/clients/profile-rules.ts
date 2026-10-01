/*
 * Pure rules for the profile fields (0027) and the Stripe figures beside
 * them — kept free of server imports so they are tested directly.
 */

/** A web address as typed → https URL, or an error. Blank → null. */
export function normalizeWebUrl(v: string | null | undefined, label: string): { value: string | null; error?: string } {
  const t = (v ?? "").trim();
  if (!t) return { value: null };
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (!/\./.test(u.hostname) || /\s/.test(t)) throw new Error("bad host");
    let out = u.toString();
    // "example.com" stays "https://example.com", not "https://example.com/".
    if (u.pathname === "/" && !u.search && !u.hash && out.endsWith("/")) out = out.slice(0, -1);
    return { value: out };
  } catch {
    return { value: null, error: `${label} must be a web address, e.g. example.com.` };
  }
}

export const isEmail = (v: string) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(v.trim());

/** Stripe's average month: 365.25 / 12 days. Stripe's MRR uses it ($750 every 14 days → $1,630.58). */
export const AVG_MONTH_DAYS = 30.4375;

/** One recurring price as a monthly amount, the way Stripe's MRR normalizes it. */
export function monthlyAmount(amount: number, interval: string | undefined, count = 1): number {
  const n = count > 0 ? count : 1;
  switch (interval) {
    case "day": return (amount * AVG_MONTH_DAYS) / n;
    case "week": return (amount * AVG_MONTH_DAYS) / (7 * n);
    case "month": return amount / n;
    case "year": return amount / (12 * n);
    default: return 0;
  }
}

export const cents = (n: number) => Math.round(n * 100) / 100;
