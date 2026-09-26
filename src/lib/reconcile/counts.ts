import { COVERAGE_TOOL_LABELS, type CoverageTool } from "./coverage";

/*
 * Why each tool's client count is not 52 — as arithmetic that has to balance.
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION THIS ANSWERS
 *
 * §2 sets the test: "If the master system contains 40 clients, all connected
 * systems should be able to identify those same 40 clients. We should never
 * have 40 clients in one system, 38 in another, 42 in another, 39 in another."
 *
 * Open the four tools today and you see 57, 50, 53 and 44 against a master
 * list of 52 — which looks exactly like the failure that sentence describes.
 * It is not, but nothing on screen proved it, and "trust me, they are all
 * explained" is not an answer somebody can check.
 *
 * So this states the arithmetic per tool:
 *
 *     rows in the tool  =  rows belonging to a master client
 *                       +  rows that are not a client at all   (named)
 *
 *     master clients    =  clients present in the tool
 *                       +  clients deliberately absent          (with reasons)
 *                       +  clients missing for no reason        (must be zero)
 *
 * If either line fails to balance, something is unaccounted for — and that,
 * rather than the raw difference in totals, is the real finding. `balances`
 * says which.
 *
 * ---------------------------------------------------------------------------
 * A DUPLICATE IS NOT AN EXTRA
 *
 * Two rows claiming the SAME master client is a different thing from a row
 * claiming no client, so they are counted apart. Calling both "extra" would
 * file a real duplicate alongside Demo Portal, which is deliberate.
 *
 * But a second row is NOT automatically a fault, and this module must not
 * pretend otherwise. Properties & Estates genuinely runs a Boston portal and a
 * Florida portal; SERHANT. PA runs a base portal and a "15M+" one. Those second
 * rows are the business working as intended — they are the open question in
 * §4 of the handover, not a defect. Meanwhile the Database app holds "Camelot
 * Realty" and "Camelot Realty Group" for one client, created the same day, both
 * empty: that one IS an accident.
 *
 * Nothing here can tell those apart on its own, so it reports them by name and
 * leaves the judgement to a person — the same reason §17 asks for written
 * exceptions rather than a hard-coded rule. Crying "duplicate" at a working
 * second market is how a check gets ignored.
 */

/** One row in a tool, already matched to a master client (or to nothing). */
export interface ToolRow {
  /** The tool's own name for the row — used to name extras and duplicates. */
  name: string;
  /** Master client id, or null when this row is not a client. */
  clientId: string | null;
}

export interface MasterClient {
  id: string;
  name: string;
  status: string;
}

export interface AbsentClient {
  name: string;
  status: string;
  /** Empty string when nothing explains the absence — i.e. a real gap. */
  reason: string;
}

export interface SecondRow {
  /** The row that comes after the first one for this client. */
  name: string;
  /** The master client both rows claim. */
  of: string;
}

export interface CountReconciliation {
  tool: CoverageTool;
  label: string;
  /** Always the size of the master list. */
  masterTotal: number;
  /** What the tool itself reports. */
  toolRows: number;
  /** Master clients with at least one row here. */
  present: number;
  /** Master clients with no row here, each with a reason where one exists. */
  absent: AbsentClient[];
  /** Absences with no reason at all. The only number worth acting on. */
  gaps: number;
  /** Rows belonging to no master client, by name. */
  extras: string[];
  /**
   * Second and later rows for a client that already had one. Legitimate for a
   * client with several markets; an accident otherwise. Named, never judged.
   */
  secondRows: SecondRow[];
  /** present + secondRows + extras === toolRows */
  balances: boolean;
}

/**
 * `absenceReason` returns the written or standing-rule reason a client is not
 * in a tool, or null when nothing explains it. Injected rather than computed
 * here so this module stays pure and the reasons keep coming from one place —
 * `buildCoverage`, which already decides them.
 */
export function reconcileCounts(
  master: MasterClient[],
  rowsByTool: Partial<Record<CoverageTool, ToolRow[]>>,
  absenceReason: (clientId: string, tool: CoverageTool) => string | null,
): CountReconciliation[] {
  const byId = new Map(master.map((c) => [c.id, c]));
  const out: CountReconciliation[] = [];

  for (const [toolKey, rows] of Object.entries(rowsByTool)) {
    if (!rows) continue;
    const tool = toolKey as CoverageTool;

    const seen = new Set<string>();
    const extras: string[] = [];
    const secondRows: SecondRow[] = [];

    for (const row of rows) {
      if (!row.clientId || !byId.has(row.clientId)) {
        extras.push(row.name);
        continue;
      }
      if (seen.has(row.clientId)) {
        secondRows.push({ name: row.name, of: byId.get(row.clientId)!.name });
        continue;
      }
      seen.add(row.clientId);
    }

    const absent: AbsentClient[] = [];
    for (const c of master) {
      if (seen.has(c.id)) continue;
      absent.push({ name: c.name, status: c.status, reason: absenceReason(c.id, tool) ?? "" });
    }

    out.push({
      tool,
      label: COVERAGE_TOOL_LABELS[tool] ?? tool,
      masterTotal: master.length,
      toolRows: rows.length,
      present: seen.size,
      absent,
      gaps: absent.filter((a) => !a.reason).length,
      extras,
      secondRows,
      balances: seen.size + secondRows.length + extras.length === rows.length,
    });
  }

  return out;
}

/**
 * One line a person can read: "44 rows = 43 clients + 1 second row".
 * Built here rather than in the component so the wording is testable.
 */
export function explainCount(r: CountReconciliation): string {
  const parts = [`${r.present} client${r.present === 1 ? "" : "s"}`];
  if (r.secondRows.length)
    parts.push(`${r.secondRows.length} second row${r.secondRows.length === 1 ? "" : "s"}`);
  if (r.extras.length) parts.push(`${r.extras.length} not a client`);
  const absent = r.absent.length
    ? `, and ${r.absent.length} of the ${r.masterTotal} clients ${r.absent.length === 1 ? "is" : "are"} not here`
    : "";
  return `${r.toolRows} rows = ${parts.join(" + ")}${absent}.`;
}
