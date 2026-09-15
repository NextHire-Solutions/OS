/*
 * Does this copy actually vary?
 *
 * Lifted from the tool's `components/campaigns/sequence-view.tsx`, where
 * `hasSpintax` and `spintaxOf` sit inside a React file beside its Tailwind
 * markup. Only the two functions come across — they are pure, they are asked by
 * two screens here (the campaign detail's sequence tab and Copy & Offer's
 * "copy that never changes"), and importing a component to get at a regular
 * expression would drag shadcn in with it.
 *
 * The comments are the tool's own, because they are the reason the pattern is
 * shaped the way it is.
 */

/**
 * Does this text carry spintax?
 *
 * EmailBison's spintax is a DOUBLE-braced block containing a pipe:
 * `{{Hi | Hello | Hey}}`. Single braces are merge variables (`{FIRST_NAME}`),
 * and `{{firstName}}` is a double-braced variable — no pipe, so it must not
 * count. Requiring the pipe is what separates the two.
 *
 * The inner alternation allows one level of nesting because an option often
 * contains a variable: `{{Hi {FIRST_NAME}, | Hey {FIRST_NAME},}}`. A pattern
 * that cannot cross those braces silently misses exactly the well-personalised
 * copy you would least expect to be missed.
 *
 * KEPT IN STEP WITH migration 064's SQL, which asks the same question of the
 * same column. Two answers to "is this spintaxed" on one screen would be worse
 * than none.
 */
const SPINTAX = /\{\{(?:[^{}]|\{[^{}]*\})*\|(?:[^{}]|\{[^{}]*\})*\}\}/;

export function hasSpintax(text: string | null | undefined): boolean {
  return text ? SPINTAX.test(text) : false;
}

export interface SpintaxStep {
  email_body?: string | null;
  email_subject?: string | null;
  variants?: unknown[];
}

/**
 * How much of a sequence varies its wording, counting variants as variation.
 *
 * Variants are the other way to vary copy, so a sequence using them is not
 * "unvaried" — reporting it as such would be wrong for the 15 campaigns that
 * do exactly that.
 */
export function spintaxOf(steps: SpintaxStep[]): {
  steps: number;
  spun: number;
  variants: number;
  varied: boolean;
} {
  const spun = steps.filter(
    (s) => hasSpintax(s.email_body) || hasSpintax(s.email_subject),
  ).length;
  const variants = steps.reduce((n, s) => n + (s.variants?.length ?? 0), 0);
  return { steps: steps.length, spun, variants, varied: spun > 0 || variants > 0 };
}
