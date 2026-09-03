import { NextResponse } from "next/server";
import { diffRosters } from "@/lib/reconcile/names";
import { fetchRosters, type Roster } from "@/lib/reconcile/rosters";

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
  const rosters = await fetchRosters();
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
