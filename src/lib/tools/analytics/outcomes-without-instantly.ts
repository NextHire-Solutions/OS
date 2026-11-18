/*
 * Attribution's figures with Instantly's outcomes taken out, for while Instantly
 * is switched off in Campaign Analytics (instantly-switch.ts; the user chose on
 * 19 Nov that past Instantly numbers leave the totals too).
 *
 * The outcome totals, campaign table, timeline and list take a platform filter
 * in SQL ("emailbison" + "direct"). Two reads do not: the coverage strip and the
 * list's dropdown counts are computed over every outcome in range, so the
 * Instantly share is subtracted here. Every Instantly outcome is resolved
 * "other_platform" the moment it is synced (sync/jobs.ts), never credited to a
 * campaign, so it sits in exactly three coverage figures: total, otherPlatform
 * and byMethod.other_platform.
 *
 * Kept free of `@/` imports so plain Node tests can import it.
 */

export interface OutcomeCoverage {
  total: number;
  attributed: number;
  otherPlatform: number;
  unattributed: number;
  pending: number;
  byMethod: Record<string, number>;
  byPlatform: Record<string, number>;
}

export function coverageWithoutInstantly(c: OutcomeCoverage): OutcomeCoverage {
  const instantly = Number(c.byPlatform.instantly ?? 0);
  const byPlatform = { ...c.byPlatform };
  delete byPlatform.instantly;
  const byMethod = { ...c.byMethod };
  const otherLeft = Number(byMethod.other_platform ?? 0) - instantly;
  if (otherLeft > 0) byMethod.other_platform = otherLeft;
  else delete byMethod.other_platform;
  return {
    ...c,
    total: Math.max(0, c.total - instantly),
    otherPlatform: Math.max(0, c.otherPlatform - instantly),
    byPlatform,
    byMethod,
  };
}

export interface OutcomeFacet {
  kind: string;
  value: string;
  n: number;
}

/**
 * The list's dropdown options without Instantly: no "instantly" source, and each
 * outcome type's count less its Instantly outcomes (`instantlyByType`). A type
 * left with none is dropped, as the SQL never offers an empty one.
 */
export function facetsWithoutInstantly(
  facets: readonly OutcomeFacet[],
  instantlyByType: ReadonlyMap<string, number>,
): OutcomeFacet[] {
  return facets
    .filter((f) => !(f.kind === "platform" && f.value === "instantly"))
    .map((f) => (f.kind === "type" ? { ...f, n: f.n - (instantlyByType.get(f.value) ?? 0) } : f))
    .filter((f) => f.n > 0);
}

/**
 * The sources the outcome list asks for while Instantly is off: the list's own
 * Source choice when it is EmailBison or Direct, otherwise both of those.
 */
export function outcomeListPlatforms(chosen: readonly string[]): string[] {
  const kept = chosen.filter((p) => p !== "instantly");
  return kept.length ? kept : ["emailbison", "direct"];
}
