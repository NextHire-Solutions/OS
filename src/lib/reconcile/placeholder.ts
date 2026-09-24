/*
 * Which roster rows are buckets rather than customers.
 *
 * Pure and dependency-free so the test can import THIS, rather than keeping a
 * copy. It used to live in `rosters.ts`, which is `server-only` and pulls in
 * the whole HTTP stack, so the test duplicated the regex with a comment
 * admitting the risk: "if it changes there and not here, these tests keep
 * passing while production changes behaviour."
 *
 * That is exactly what happened on the first attempt at widening it. One
 * definition, imported by both, removes the failure mode rather than
 * commenting on it.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATELY STILL NARROW
 *
 * The obvious fix for "Test FUB" and "Demo Portal" appearing as client
 * differences is to widen this until it swallows them. That is the wrong
 * mechanism, and `roster.ts` already has the right one: NOT_CLIENTS, a named
 * list with a REASON for each row — "Demo Portal: backs the live demo client
 * portal — keep".
 *
 * A regex cannot carry a reason, and this one would have swallowed a client
 * called "Testa Group" or "Demographics Realty" to catch four rows that are
 * already listed by name a file away. So this stays as it was, matching only
 * a name that IS the bucket word, and rosters.ts excludes known non-clients
 * separately — with their reason shown rather than silently dropped.
 */
export const PLACEHOLDER = /^(unassigned|unknown|none|n\/?a|test|demo)$/i;

export function isPlaceholder(name: string): boolean {
  return PLACEHOLDER.test(name.trim());
}
