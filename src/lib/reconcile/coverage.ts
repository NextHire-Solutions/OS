/*
 * Which tools hold each client, and whether an absence is intentional.
 *
 * The architecture spec, §17:
 *
 *     Client exists in master system -> Tool connection = Yes/No
 *     If No, there should be a clear reason.
 *     This allows us to distinguish INTENTIONAL EXCEPTION from SYSTEM FAILURE.
 *
 * That distinction is the whole job. A screen that reports every absence is
 * useless — nine churned clients across four tools is thirty-six rows nobody
 * will read twice — and one that suppresses absences by rule hides the real
 * ones. So each gap resolves to exactly one of three things:
 *
 *   explained   a person wrote a reason (os_client_tool_exceptions)
 *   expected    a standing rule below covers it, and the rule is shown
 *   gap         nobody has accounted for it — the only kind worth a person
 *
 * ---------------------------------------------------------------------------
 * THE STANDING RULES, AND WHY THEY ARE NOT JUST SUPPRESSION
 *
 * A rule here has to be true by the definition of the tool, not merely
 * convenient — otherwise it is suppression wearing a better name, and the
 * absence it hides is the one that mattered.
 *
 *   churned clients        A churned client is not in Analytics because
 *                          attribution stopped, and often not in Onboarding
 *                          because that pipeline is for intake. Their absence
 *                          is what churn MEANS; reporting it is reporting the
 *                          status twice.
 *
 *   onboarding clients     A client being set up has not reached every tool
 *                          yet, by definition. That is the setup running, not
 *                          a failure — until it finishes, which is a different
 *                          question this screen does not try to answer.
 *
 * ACTIVE and PAUSED clients get no standing rule at all. A paused client is
 * still a client: still billed, still holding a portal, still expected
 * everywhere. If one is missing from a tool, somebody should either fix it or
 * write down why — which is exactly what §17 asks for.
 */

export type CoverageTool =
  | "master_inbox"
  | "client_health"
  | "analytics"
  | "onboarding"
  | "database"
  | "portal";

export const COVERAGE_TOOL_LABELS: Record<CoverageTool, string> = {
  master_inbox: "Master Inbox",
  client_health: "Client Health",
  analytics: "Analytics",
  onboarding: "Onboarding",
  database: "Database",
  portal: "Client portal",
};

export type Verdict = "present" | "explained" | "expected" | "gap";

export interface CoverageCell {
  tool: CoverageTool;
  label: string;
  verdict: Verdict;
  /** Why it is explained or expected. Empty for present, and for a gap. */
  reason?: string;
}

export interface CoverageRow {
  clientId: string;
  name: string;
  status: string;
  cells: CoverageCell[];
  gaps: CoverageTool[];
}

export interface CoverageReport {
  rows: CoverageRow[];
  /** Clients with at least one unaccounted-for absence. The number to act on. */
  withGaps: number;
  /** Per tool: how many clients are missing from it without an explanation. */
  gapsByTool: { tool: CoverageTool; label: string; gaps: number }[];
  /** Absences a person has written a reason for. */
  explained: number;
  /** Absences a standing rule covers. */
  expected: number;
  /** Tools whose roster could not be read, so their column means nothing. */
  unreadable: CoverageTool[];
}

export interface CoverageInput {
  clientId: string;
  name: string;
  status: string;
  /** Whether each tool holds this client. Absent key = tool not checked. */
  present: Partial<Record<CoverageTool, boolean>>;
}

/** os_client_id -> tool -> reason */
export type ExceptionIndex = Map<string, Map<CoverageTool, string>>;

function standingRule(status: string): string | null {
  if (status === "churned") {
    return "Churned. Absence from a tool is what churn means here, not a failure.";
  }
  if (status === "onboarding") {
    return "Still onboarding — not every tool has been set up yet.";
  }
  return null;
}

export function buildCoverage(
  clients: CoverageInput[],
  exceptions: ExceptionIndex = new Map(),
  unreadable: CoverageTool[] = [],
  tools: CoverageTool[] = ["master_inbox", "client_health", "analytics", "onboarding"],
): CoverageReport {
  const unreadableSet = new Set(unreadable);
  const rows: CoverageRow[] = [];
  const gapCount = new Map<CoverageTool, number>(tools.map((t) => [t, 0]));
  let explained = 0;
  let expected = 0;

  for (const client of clients) {
    const cells: CoverageCell[] = [];
    const gaps: CoverageTool[] = [];
    const forClient = exceptions.get(client.clientId);
    const rule = standingRule(client.status);

    for (const tool of tools) {
      const label = COVERAGE_TOOL_LABELS[tool];

      /*
       * A tool we could not read tells us nothing. Reporting its clients as
       * absent would invent a screenful of gaps out of one failed request —
       * the "false calm" failure mode inverted, and just as damaging.
       */
      if (unreadableSet.has(tool)) {
        cells.push({ tool, label, verdict: "expected", reason: `${label} could not be read.` });
        continue;
      }

      if (client.present[tool]) {
        cells.push({ tool, label, verdict: "present" });
        continue;
      }
      if (client.present[tool] === undefined) {
        cells.push({ tool, label, verdict: "expected", reason: `${label} was not checked.` });
        continue;
      }

      // A written reason always wins over a standing rule: somebody looked.
      const written = forClient?.get(tool);
      if (written) {
        explained += 1;
        cells.push({ tool, label, verdict: "explained", reason: written });
        continue;
      }
      if (rule) {
        expected += 1;
        cells.push({ tool, label, verdict: "expected", reason: rule });
        continue;
      }

      gaps.push(tool);
      gapCount.set(tool, (gapCount.get(tool) ?? 0) + 1);
      cells.push({ tool, label, verdict: "gap" });
    }

    rows.push({ clientId: client.clientId, name: client.name, status: client.status, cells, gaps });
  }

  // Most gaps first, then by name, so the worst-covered clients lead.
  rows.sort((a, b) => b.gaps.length - a.gaps.length || a.name.localeCompare(b.name));

  return {
    rows,
    withGaps: rows.filter((r) => r.gaps.length > 0).length,
    gapsByTool: tools.map((tool) => ({
      tool,
      label: COVERAGE_TOOL_LABELS[tool],
      gaps: gapCount.get(tool) ?? 0,
    })),
    explained,
    expected,
    unreadable,
  };
}
