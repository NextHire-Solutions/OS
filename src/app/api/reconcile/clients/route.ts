import { NextResponse } from "next/server";
import { diffRosters } from "@/lib/reconcile/names";
import { fetchRosters, type Roster } from "@/lib/reconcile/rosters";
import { canonicaliseRosters } from "@/lib/reconcile/canonicalise";
import {
  gatherCoverageReport,
  gatherDuplicateReport,
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
  const [rosters, statusReport, coverageReport, linkReport, duplicateReport] = await Promise.all([
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
    gatherDuplicateReport().catch((error) => ({
      findings: [],
      checked: 0,
      error: error instanceof Error ? error.message : "duplicate check failed",
    })),
  ]);
  /*
   * Resolve every tool row through the MASTER RECORD before comparing.
   *
   * Without this the screen compares tool to tool by name, so one client
   * spelled differently in two tools reads as two one-sided differences —
   * "Douglas Elliman Los Angeles" only in Master Inbox, "Douglas Elliman LA"
   * only in Analytics. os_clients already records both as the same client,
   * and Layer 1 of the spec is precisely that every tool should reference the
   * master list rather than be compared against another tool's spelling.
   *
   * The tool's own wording is kept on the entry, so a row still shows how
   * that tool writes it — the difference simply stops being reported as a
   * missing client.
   */
  const canonical = await canonicaliseRosters(rosters);
  const available = canonical.filter((r: Roster) => !r.unavailable);

  /*
   * Why a client is absent from a tool, in one sentence, or null when nothing
   * accounts for it. Built from the master record's status plus the tool's own
   * nature — the same two rules the coverage panel uses, so the two panels can
   * never give different answers about the same client.
   */
  const statusByName = new Map(
    (coverageReport.rows ?? []).map((r: { name: string; status: string }) => [
      r.name.toLowerCase(),
      r.status,
    ]),
  );
  const explain = (name: string, missingFrom: string): string | null => {
    if (missingFrom === "Onboarding") {
      return "The Onboarding tool is a Typeform intake pipeline, not a roster — nothing ever creates a client in it.";
    }
    const status = statusByName.get(name.toLowerCase());
    if (status === "churned") return "Churned — absence from a tool is what churn means here.";
    if (status === "onboarding") {
      return missingFrom === "Client Health"
        ? "Still onboarding — not yet on the billed roster."
        : "Still onboarding — not every tool has been set up yet.";
    }
    return null;
  };

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
        /*
         * Each one-sided row carries WHY it is one-sided.
         *
         * A difference being real does not make it a problem: a churned client
         * is correctly gone from Analytics, and a client still onboarding is
         * correctly not yet on the billed roster. Listing them with no reason
         * makes a panel that says "Differs" forever, which is the fastest way
         * to have it ignored — so the same rules the coverage panel applies
         * are applied here, and the badge counts only what is unexplained.
         */
        onlyLeft: diff.onlyLeft.map((e) => ({ name: e.name, ...e.meta, why: explain(e.name, right.label) })),
        onlyRight: diff.onlyRight.map((e) => ({ name: e.name, ...e.meta, why: explain(e.name, left.label) })),
        unexplained:
          diff.onlyLeft.filter((e) => !explain(e.name, right.label)).length +
          diff.onlyRight.filter((e) => !explain(e.name, left.label)).length,
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
    // Two master rows for one real client, or two claiming one tool row (§16).
    duplicates: duplicateReport,
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
