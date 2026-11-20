/*
 * A hand-off that has really gone is an introduction (20 Nov, the user: "these automatic hand off agents should be
 * automatically labeled as introduction and added to the client portal pipeline and all the actions after").
 *
 * For a client on the Introduction model (os_clients.pipeline_entry = 'introduction'), once the agent's reply has been
 * emailed to the brokerage, the conversation is labelled Introduction, exactly as a person does after pressing
 * Introduce: the Pipeline entry (the label's trigger), the introduction count (Client Health reads the label), and
 * the usual alerts (Slack, Follow Up Boss, the text alert) through applyLabelToThread, which never announces twice.
 * The new model (pipeline_entry = 'interested', clients billed per lead) is unchanged: Pipeline entry at Interested,
 * no label. Billing is unaffected: it counts every conversation EVER marked Interested.
 *
 * Pure: when to label. The label itself is handoff-introduction-io.ts.
 */

/** The labels a hand-off starts from (rules.ts TRIGGER_LABELS): still one of these means nobody has decided otherwise. */
const TRIGGERS = new Set(["interested", "meetings booked"]);

/** How long the label waits for the Interested Slack alert, which posts only while the conversation still says Interested. */
export const INTRO_ALERT_WAIT_MS = 10 * 60_000;

export type IntroduceFn = (threadId: string) => Promise<{ ok: true; announced: boolean } | { ok: false; error: string }>;

export type IntroduceDecision =
  /** Label it now. */
  | "label"
  /** The Interested alert hasn't had its turn yet: next sweep. */
  | "wait"
  /** It carries Introduction already (a person introduced it): nothing to do, nothing announced again. */
  | "already"
  /** A person relabelled it since (Not Interested, Do Not Contact, Keep Warm...), or took the label off: their call stands. */
  | "relabelled";

export function introduceDecision(i: { labels: string[]; alertSettled: boolean; waitedMs: number }): IntroduceDecision {
  const names = i.labels.map((l) => l.trim().toLowerCase());
  if (names.includes("introduction")) return "already";
  if (!names.some((n) => TRIGGERS.has(n))) return "relabelled";
  if (!i.alertSettled && i.waitedMs < INTRO_ALERT_WAIT_MS) return "wait";
  return "label";
}
