/*
 * Where the tools disagree about a client's STATUS.
 *
 * The existing comparison answers "which lists contain which clients". This
 * answers the other half of §16 of the architecture spec, and the spec's own
 * example is the shape it looks for:
 *
 *     Client is Active in Master
 *     Paused in Database
 *     Active in Health
 *     Missing from Portal
 *
 * That case is live today. `Spotlight - A Compass Team` is active in
 * os_clients, active in Analytics, churned in Client Health, and its portal is
 * off — and nothing surfaced it until somebody compared the four by hand.
 *
 * ---------------------------------------------------------------------------
 * THE TWO FAILURE MODES, same as the membership classifier
 *
 *   crying wolf   flagging differences that are expected, after which people
 *                 stop reading and we are back to finding these by hand;
 *   false calm    reporting agreement when a source simply had no answer.
 *
 * Three rules keep both at bay:
 *
 *   1. A source with NO ROW for a client is not a disagreement about status.
 *      It is a membership question, and the roster diff already reports it.
 *      Treating "absent" as a status would flag every churned client in every
 *      tool that never carried them.
 *
 *   2. A source that could not be READ is reported as unreadable and never
 *      counted as agreement. Silence is not consent.
 *
 *   3. `onboarding` in the master against `active` in a tool is EXPECTED. No
 *      tool has an onboarding concept — a client being set up is simply active
 *      to them. Flagging it would fire on every new client during the exact
 *      window when people are busiest.
 */

export type StatusSource = "os" | "client_health" | "analytics" | "master_inbox";

export interface StatusReading {
  source: StatusSource;
  label: string;
  /** The status this source holds, or null when it has no row for the client. */
  status: string | null;
  /** True when the source could not be read at all — never counted as agreement. */
  unreadable?: boolean;
}

export interface StatusConflict {
  name: string;
  /** os_clients is the master. Null when the master itself has no row. */
  master: string | null;
  readings: StatusReading[];
  /** Sources holding a status different from the master's. */
  disagreeing: StatusSource[];
  severity: "act" | "expected";
  why: string;
  /*
   * Whether the disagreement crosses the line that actually costs money or is
   * visible to a customer: active vs not-active. A client paused in one place
   * and churned in another is untidy; a client churned in one place and active
   * in another is still being served or still being billed.
   */
  crossesActive: boolean;
}

export interface StatusReport {
  conflicts: StatusConflict[];
  /** Clients every readable source agreed on. The number that should be large. */
  agreed: number;
  /** Sources that could not be read, so their silence is not mistaken for agreement. */
  unreadable: { source: StatusSource; label: string }[];
}

export const SOURCE_LABELS: Record<StatusSource, string> = {
  os: "OS (master)",
  client_health: "Client Health",
  analytics: "Analytics",
  master_inbox: "Master Inbox",
};

/** Normalise the spellings the tools actually store. */
export function normaliseStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  // 'prospect' was the OS's old word for 'onboarding' and may still be held by
  // a row written before migration 0013. Same state, so same word here.
  if (v === "prospect") return "onboarding";
  // Client Health's own vocabulary, in case a caller passes the raw booleans'
  // derived word rather than the column.
  if (v === "hidden") return "churned";
  return v;
}

export interface ClientStatuses {
  name: string;
  /** Per source: the status held, or null when that source has no row. */
  statuses: Partial<Record<StatusSource, string | null>>;
}

export function findStatusConflicts(
  clients: ClientStatuses[],
  unreadableSources: StatusSource[] = [],
): StatusReport {
  const unreadable = new Set(unreadableSources);
  const conflicts: StatusConflict[] = [];
  let agreed = 0;

  for (const client of clients) {
    const master = normaliseStatus(client.statuses.os ?? null);

    const readings: StatusReading[] = (Object.keys(SOURCE_LABELS) as StatusSource[]).map(
      (source) => ({
        source,
        label: SOURCE_LABELS[source],
        status: normaliseStatus(client.statuses[source] ?? null),
        ...(unreadable.has(source) ? { unreadable: true } : {}),
      }),
    );

    /*
     * Rule 1 and 2 together: only sources that are readable AND hold a row can
     * agree or disagree. Everything else is someone else's report.
     */
    const answering = readings.filter(
      (r) => r.source !== "os" && !r.unreadable && r.status !== null,
    );

    if (master === null || answering.length === 0) continue;

    const disagreeing = answering.filter((r) => r.status !== master);
    if (disagreeing.length === 0) {
      agreed += 1;
      continue;
    }

    // Rule 3: no tool has an onboarding concept, so "active" there is expected.
    const onlyOnboardingVsActive =
      master === "onboarding" && disagreeing.every((r) => r.status === "active");

    /*
     * Crossing the active line is the difference that costs money or is
     * visible to a customer — but ONLY when the crossing is unexplained. The
     * onboarding case crosses it by the letter (onboarding is not active) and
     * means nothing, so it is excluded here rather than left to be filtered
     * downstream: this flag drives both the ordering and the wording, and a
     * flag that is technically true but practically meaningless would put the
     * least interesting row at the top of the list.
     */
    const crossesActive =
      !onlyOnboardingVsActive &&
      disagreeing.some((r) => (master === "active") !== (r.status === "active"));

    conflicts.push({
      name: client.name,
      master,
      readings,
      disagreeing: disagreeing.map((r) => r.source),
      severity: onlyOnboardingVsActive ? "expected" : "act",
      why: onlyOnboardingVsActive
        ? "Master says onboarding; no tool has an onboarding state, so they read as active. Expected."
        : crossesActive
          ? describeActiveCrossing(master, disagreeing)
          : `Master says ${master}; ${listSources(disagreeing)} disagree. Both are non-active, so nothing is being served or billed on it — worth tidying, not urgent.`,
      crossesActive,
    });
  }

  /*
   * Worst first: a client being served or billed when it should not be beats a
   * paused/churned mix-up, which beats an expected difference.
   */
  const rank = (c: StatusConflict) =>
    c.severity === "expected" ? 2 : c.crossesActive ? 0 : 1;
  conflicts.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  return {
    conflicts,
    agreed,
    unreadable: unreadableSources.map((source) => ({ source, label: SOURCE_LABELS[source] })),
  };
}

function listSources(readings: StatusReading[]): string {
  const names = readings.map((r) => `${r.label} says ${r.status}`);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function describeActiveCrossing(master: string, disagreeing: StatusReading[]): string {
  return master === "active"
    ? `Master says active but ${listSources(disagreeing)} — so a client we treat as live has been stopped somewhere. Check which is right before anything re-enables it.`
    : `Master says ${master} but ${listSources(disagreeing)} — so a client we treat as stopped may still be running or being billed there.`;
}
