/**
 * The catalogue of steps a human can run on a client.
 *
 * Ported verbatim from the orchestrator's `lib/steps.ts`. No server imports, so
 * a client component can render the list without pulling Supabase into the
 * browser bundle.
 *
 * These used to fire on their own; every one is now a button. The order below is
 * the order the onboarding doc lists them in — a suggestion, not a sequence. Any
 * step can be run at any time, or skipped entirely.
 *
 * `key` is wiring and never changes. `label` is only the default caption: the
 * team renames buttons on the Settings screen and their choices are stored in
 * `orch_settings.step_labels`.
 */

export type StepKind = "email" | "push" | "build" | "campaign";

export type Step = { key: string; label: string; kind: StepKind; hint: string };

export const STEPS: Step[] = [
  { key: "email:welcome",           label: "Send welcome email",   kind: "email",    hint: "Welcome note with their onboarding call date" },
  { key: "email:confirmations",     label: "Send copy for review", kind: "email",    hint: "Campaign copy the client approves" },
  { key: "push:client_portal",      label: "Create portal",        kind: "push",     hint: "Creates their Client Portal account + intro macro" },
  { key: "email:how_intros_work",   label: "Send how intros work", kind: "email",    hint: "Explains the introduction process" },
  { key: "email:meet_team",         label: "Send meet the team",   kind: "email",    hint: "Introduces their recruiting team (cc's the TAC)" },
  { key: "email:portal",            label: "Send portal access",   kind: "email",    hint: "Their portal link — needs the portal created first" },
  { key: "email:dnc_reminder",      label: "Send DNC reminder",    kind: "email",    hint: "Asks them to add their do-not-contact list" },
  { key: "build:team",              label: "Build team",           kind: "build",    hint: "Their agents from the database + the people named in the form" },
  { key: "push:health_dash",        label: "Push to Health Dash",  kind: "push",     hint: "Adds the client to the Health Dashboard" },
  { key: "campaign:build",          label: "Create campaign",      kind: "campaign", hint: "Creates the empty EmailBison campaign" },
  { key: "build:leads",             label: "Build lead list",      kind: "build",    hint: "Builds the list and hands it to the DB app for review" },
  { key: "campaign:launch",         label: "Launch campaign",      kind: "campaign", hint: "Starts sending — do this once the DB app has imported the leads" },
  { key: "email:campaign_launched", label: "Send campaign live",   kind: "email",    hint: "Tells the client their campaign is running" },
  { key: "email:followup_call",     label: "Send follow-up",       kind: "email",    hint: "Touch Base check-in, usually ~3 weeks after onboarding" },
];

/** Apply the team's custom captions over the defaults. */
export function labelFor(step: Step, custom: Record<string, string>): string {
  return custom[step.key]?.trim() || step.label;
}
