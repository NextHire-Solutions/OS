/*
 * When drift is worth telling somebody about.
 *
 * §16 does not merely ask for detection — it asks for it to be noticed:
 *
 *   "We need to know IMMEDIATELY that there is a synchronization problem."
 *   "We should not have to discover these issues manually."
 *
 * The Consistency screen satisfied the first half and not the second: it only
 * tells you anything if you go and look at it, which is the definition of
 * discovering a problem manually. This is the push half.
 *
 * ---------------------------------------------------------------------------
 * THE HARD PART IS WHAT *NOT* TO SEND
 *
 * An alert that fires on a state nobody can act on trains people to ignore it,
 * and then the one real alert is ignored too. The screen went from 34 one-sided
 * differences to 10-with-reasons precisely so that a count would mean
 * something; an alerter that counted all 10 would undo that.
 *
 * So these are DELIBERATELY NOT actionable, and are never alerted on:
 *
 *   - an absence with a reason (churned clients are *supposed* to be gone)
 *   - the Onboarding tool not holding a client — nothing ever creates one there
 *   - a known non-client row (Demo Portal, Test FUB, the Unassigned bucket)
 *   - `unlinked`: a link not yet recorded is a gap in our bookkeeping, not
 *     drift between two systems, and it is normal for a new client
 *   - a client still onboarding being absent from the billed roster
 *
 * And these ARE, every one of them a case where two systems disagree about a
 * real client, or where the comparison itself could not be trusted:
 *
 *   - a status conflict
 *   - an UNEXPLAINED one-sided client
 *   - a duplicate (two masters for one client, or two claiming one tool row)
 *   - a stale or disagreeing stored link
 *   - a source that could not be read — §22's "sync failures are detectable".
 *     Silence here would be the worst failure of all: three of four tools
 *     unreadable looks identical to "everything agrees".
 *
 * Pure, so the test decides the policy rather than a live database.
 */

export interface ReconcileAlertInput {
  /** Clients whose status differs between tools. */
  statusConflicts: number;
  /** One-sided clients with NO reason. Explained ones are excluded upstream. */
  unexplainedOneSided: number;
  /** Two masters for one client, or two claiming one tool row. */
  duplicates: number;
  /** Stored links that are stale or disagree. `unlinked` must NOT be counted. */
  brokenLinks: number;
  /** Sources that could not be read at all, by label. */
  unreadable: string[];
  /** Checks that threw, by label — a failure of the checker itself. */
  failedChecks: { check: string; error: string }[];
  /** For the "all clear" line, so a quiet alert still proves it looked. */
  clientsChecked: number;
}

export type AlertSeverity = "clear" | "attention" | "urgent";

export interface ReconcileAlert {
  /** False when there is nothing a person could act on. Send nothing. */
  actionable: boolean;
  severity: AlertSeverity;
  title: string;
  /** One line per finding, already human-readable. */
  lines: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function buildReconcileAlert(input: ReconcileAlertInput): ReconcileAlert {
  const lines: string[] = [];

  /*
   * An unreadable source or a thrown check comes FIRST and is urgent, because
   * every other number below it is then measured over less than the whole
   * platform. Reporting "0 conflicts" from a comparison that could only read
   * two of four tools is worse than reporting nothing.
   */
  if (input.failedChecks.length > 0) {
    for (const f of input.failedChecks) {
      lines.push(`:rotating_light: The ${f.check} check failed: ${f.error}`);
    }
  }
  if (input.unreadable.length > 0) {
    lines.push(
      `:rotating_light: Could not read ${input.unreadable.join(", ")} — every figure below is ` +
        "measured over the tools that answered, not all of them.",
    );
  }

  if (input.statusConflicts > 0) {
    lines.push(
      `:warning: ${plural(input.statusConflicts, "client")} held at different statuses by ` +
        "different tools. Someone may be billed while paused, or have a live portal while churned.",
    );
  }
  if (input.unexplainedOneSided > 0) {
    lines.push(
      `:warning: ${plural(input.unexplainedOneSided, "client")} present in one tool and missing ` +
        "from another with no reason. Absences that ARE expected are excluded.",
    );
  }
  if (input.duplicates > 0) {
    lines.push(
      `:warning: ${plural(input.duplicates, "duplicate")} in the master list. Two rows for one ` +
        "client make every tool's name join arbitrary, and the campaign matcher abandons both.",
    );
  }
  if (input.brokenLinks > 0) {
    lines.push(
      `:warning: ${plural(input.brokenLinks, "stored link")} stale or pointing at the wrong row. ` +
        "Links not yet recorded are not counted.",
    );
  }

  const blocked = input.failedChecks.length > 0 || input.unreadable.length > 0;
  const actionable = lines.length > 0;

  if (!actionable) {
    return {
      actionable: false,
      severity: "clear",
      title: "Client data consistent",
      lines: [
        `:white_check_mark: ${plural(input.clientsChecked, "client")} checked across every tool — ` +
          "no status conflicts, no unexplained gaps, no duplicates, every link sound.",
      ],
    };
  }

  return {
    actionable: true,
    severity: blocked ? "urgent" : "attention",
    title: blocked ? "Client data check could not complete" : "Client data needs attention",
    lines,
  };
}

/** The Slack message body, or null when there is nothing worth sending. */
export function alertText(alert: ReconcileAlert, screenUrl?: string): string | null {
  if (!alert.actionable) return null;
  const head = alert.severity === "urgent" ? `*${alert.title}*` : `*${alert.title}*`;
  const tail = screenUrl ? `\n\nOpen the Consistency screen: ${screenUrl}` : "";
  return `${head}\n${alert.lines.map((l) => `• ${l}`).join("\n")}${tail}`;
}
