import "server-only";

import { CONCEPTS } from "./concepts";
import { compare, summarise } from "./classify";
import { read } from "./readers";
import type { ReconcileReport } from "./types";

/*
 * Runs every reader and compares the results.
 *
 * All readers for all concepts fire at once rather than concept by concept.
 * Several concepts read the SAME upstream endpoint (three of them come out of
 * the Analytics KPI band), and a sequential pass would make the slowest tool
 * set the pace for the whole report.
 *
 * Every reader is written not to throw, and `allSettled` is belt-and-braces: a
 * single upstream having a bad day must degrade one row, never the page.
 */
export async function reconcile(): Promise<ReconcileReport> {
  const comparisons = await Promise.all(
    CONCEPTS.map(async (concept) => {
      const settled = await Promise.allSettled(concept.sources.map((s) => read(s)));

      const readings = settled.map((outcome, i) => {
        if (outcome.status === "fulfilled") return outcome.value;
        const spec = concept.sources[i];
        return {
          tool: spec.tool,
          key: spec.key,
          label: spec.label,
          definition: spec.definition,
          origin: spec.origin,
          value: null,
          unavailable:
            outcome.reason instanceof Error ? outcome.reason.message : "read threw",
          fetchedAt: new Date().toISOString(),
        };
      });

      return compare(concept, readings, concept.sources);
    }),
  );

  return {
    comparisons,
    generatedAt: new Date().toISOString(),
    summary: summarise(comparisons),
  };
}
