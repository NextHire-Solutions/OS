import { NextResponse } from "next/server";
import { diffRosters } from "@/lib/reconcile/names";
import { fetchRosters, type Roster } from "@/lib/reconcile/rosters";
import {
  gatherCoverageReport,
  gatherLinkReport,
  gatherStatusReport,
} from "@/lib/reconcile/status-readers";

export const dynamic = "force-dynamic";

/*
 * Which clients each tool knows about, and where they disagree.
 *
 * The totals view says "57 against 41". This says which 16, which is the only
 * form anyone can act on. Every pair of readable rosters is compared, so a
 * single unavailable tool costs one comparison rather than the whole screen.
 *
 * Names, not ids, because only Analytics has a real key — Client Health and the
 * Database app both join clients by normalised name, which is exactly why the
 * lists drift in the first place.
 */
export async function GET() {
  /*
   * Two halves of the same question, gathered together:
   *   rosters  — WHICH clients each tool knows about (membership)
   *   statuses — what each tool thinks the SAME client's status is
   *
   * The second half is the spec's §16 example ("Active in Master, Paused in
   * Database, Active in Health"). Membership drift was already visible here;
   * status drift was not, and that is how a client stayed active in the master
   * while Client Health had it churned and its portal shut.
   *
   * The status read fails alone: it is caught so a database being slow costs
   * that panel, never the membership comparison people already rely on.
   */
  const [rosters, statusReport, coverageReport, linkReport] = await Promise.all([
    fetchRosters(),
    gatherStatusReport().catch((error) => ({
      conflicts: [],
      agreed: 0,
      unreadable: [],
      error: error instanceof Error ? error.message : "status comparison failed",
    })),
    gatherCoverageReport().catch((error) => ({
      rows: [],
      withGaps: 0,
      gapsByTool: [],
      explained: 0,
      expected: 0,
      unreadable: [],
      error: error instanceof Error ? error.message : "coverage check failed",
    })),
    gatherLinkReport().catch((error) => ({
      findings: [],
      sound: 0,
      unchecked: [],
      error: error instanceof Error ? error.message : "link check failed",
    })),
  ]);
  const available = rosters.filter((r) => !r.unavailable);

  const comparisons: unknown[] = [];
  for (let i = 0; i < available.length; i++) {
    for (let j = i + 1; j < available.length; j++) {
      const left = available[i];
      const right = available[j];
      const diff = diffRosters(left.entries, right.entries);

      comparisons.push({
        left: { tool: left.tool, label: left.label, count: left.entries.length },
        right: { tool: right.tool, label: right.label, count: right.entries.length },
        definitions: { [left.tool]: left.definition, [right.tool]: right.definition },
        summary: {
          matched: diff.matched.length,
          likely: diff.likely.length,
          onlyLeft: diff.onlyLeft.length,
          onlyRight: diff.onlyRight.length,
        },
        // The three buckets stay separate all the way to the client. Merging
        // `likely` into either neighbour is what turns this from a useful
        // screen into one that either hides drift or invents it.
        matched: diff.matched.map((m) => m.name),
        likely: diff.likely.map((l) => ({
          left: l.left.name,
          right: l.right.name,
          score: Math.round(l.score * 100) / 100,
        })),
        onlyLeft: diff.onlyLeft.map((e) => ({ name: e.name, ...e.meta })),
        onlyRight: diff.onlyRight.map((e) => ({ name: e.name, ...e.meta })),
      });
    }
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    // Where the tools hold the same client at different statuses.
    statuses: statusReport,
    // Which tools hold each client, and whether an absence is intentional (§17).
    coverage: coverageReport,
    // Whether the links os_clients records still point where they should.
    links: linkReport,
    rosters: rosters.map((r: Roster) => ({
      tool: r.tool,
      label: r.label,
      definition: r.definition,
      count: r.entries.length,
      // Placeholder rows ("Unassigned", "Unknown") are dropped before
      // comparing, and named here. Filtering silently would be indistinguish-
      // able from a bug that eats a real client.
      excluded: r.excluded ?? [],
      unavailable: r.unavailable ?? null,
    })),
    comparisons,
    // Stated rather than left to be inferred from a short list: a comparison
    // that silently covers two of three tools looks complete and isn't.
    unavailable: rosters
      .filter((r) => r.unavailable)
      .map((r) => ({ tool: r.tool, label: r.label, reason: r.unavailable })),
  });
}
