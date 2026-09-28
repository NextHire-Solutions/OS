import type { AlertSeverity } from "./alert";

/*
 * THE LAST DAILY CHECK, KEPT WHERE PEOPLE WILL SEE IT.
 *
 * §16: "we should not have to discover these issues manually". The daily check
 * existed but only ever reported to Slack, which is switched off until a
 * channel is chosen — so it ran, decided, and threw the answer away. Keeping
 * the latest result lets Home show it with no outside destination at all.
 * Slack remains an addition, not a replacement.
 *
 * In memory, per process: the OS has no settings table, and the check re-runs
 * shortly after every start (scheduler.ts), so a deploy costs a few minutes of
 * "not checked yet", never a stale all-clear.
 */

export interface LastCheck {
  generatedAt: string;
  actionable: boolean;
  severity: AlertSeverity;
  title: string;
  lines: string[];
  clientsChecked: number;
}

const KEY = Symbol.for("brokerstaffer.reconcile.last");
const slot = globalThis as unknown as { [KEY]?: LastCheck };

export function recordLastCheck(check: LastCheck): void {
  slot[KEY] = check;
}

export function lastCheck(): LastCheck | null {
  return slot[KEY] ?? null;
}
