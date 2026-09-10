/*
 * The pipeline's shared vocabulary — stage names, labels, row shapes, and the
 * pure helpers over them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SEPARATE FROM portal-data.ts
 *
 * Nine client components need these: the board, the kanban, the header, both
 * detail views, the stage manager, the label editor, the labels context and the
 * conversation sheet.
 *
 * In the tool they sit beside the loaders in `portal-data.ts`, which is fine
 * there because nothing in that file is `server-only`. Here the loaders reach
 * the database through `@/lib/supabase/admin`, which IS marked `server-only` —
 * deliberately, because it carries the service-role key and that key must never
 * reach a client bundle. A client component importing one string constant
 * therefore failed the build:
 *
 *     'server-only' cannot be imported from a Client Component module
 *
 * The fix is not to unmark the admin client — that marker is what keeps the key
 * out of the browser — but to put the pure half where both sides can reach it.
 * `portal-data.ts` re-exports all of this, so server-side import sites are
 * unchanged and stay diffable against the tool.
 *
 * REGENERATING THIS FILE: it is produced by splitting the tool's
 * `lib/portals/portal-data.ts`. When that file changes upstream, re-copy it and
 * re-apply the split rather than hand-editing here.
 */

export type PipelineStage =
  | "introduction"
  | "phone_screen_scheduled"
  | "phone_screen"
  // Added 2026-06-12, gated to Demo Portal only via the
  // "interview_scheduled_stage" feature flag (see
  // lib/portals/feature-flags.ts). Real clients use
  // visibleStagesFor() below, which omits this from every
  // dropdown / chip / legend they render, so the new stage stays
  // invisible to them until rollout is approved. The enum value
  // itself lives in Postgres (migration 0052) so the type can
  // include it safely.
  | "interview_scheduled"
  | "interview"
  | "hired"
  | "keep_warm"
  | "we_they_rejected"
  | "no_show";

export interface PipelineNote {
  id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface PipelineEntry {
  id: string;
  stage: PipelineStage;
  // Display-only overlay (manage_stages): when set, the entry renders in this
  // custom stage instead of its canonical `stage`. Always null for real clients
  // (they never set it) and for any entry sitting on a canonical stage.
  custom_stage_key: string | null;
  needs_replacement: boolean;
  lead_name: string | null;
  lead_email: string | null;
  lead_phone: string | null;
  current_brokerage: string | null;
  agent_profile_url: string | null;
  // Derived at load time from the lead's enrichment payload — surfaced
  // as separate columns so the row template can render them without
  // each component hunting through custom_fields.
  lead_location: string | null;
  introduced_at: string | null;
  // Full Instantly enrichment payload for the lead detail side-panel.
  // null when the entry was triggered by a label assignment (no
  // external_intros row backed it).
  lead_detail: Record<string, unknown> | null;
  // Keys in custom_fields that exist ONLY as per-entry overrides — i.e. fields
  // a user added manually, not present in the shared Bison/Instantly
  // enrichment. These are the only custom fields safe to DELETE (removing an
  // enrichment override would just revert to the source value). Omitted/empty
  // for legacy rows.
  manual_custom_field_keys?: string[];
  campaign_name: string | null;
  // FK to threads.id. Populated by the Introduction-label trigger
  // and by the external_intros backfill (migration 0023/0027). Null
  // for entries the operator added manually from the portal — those
  // have no email thread to show, so the "View conversation" button
  // is gated off this.
  thread_id: string | null;
  // Timestamped notes (newest first). Backed by client_pipeline_notes.
  notes_log: PipelineNote[];
  // Recruiter ownership — points at a row in client_team_members
  // (the intro-notification roster). null = unassigned.
  // assigned_team_member is the joined display tuple, fetched in the
  // same SELECT so the row UI doesn't need a second hop.
  assigned_team_member_id: string | null;
  assigned_team_member: { id: string; name: string } | null;
  // Follow Up Boss push state. Set when the entry has been
  // successfully pushed (auto or manual). fub_last_error captures
  // the most recent failure so the row can surface "Push failed:
  // <reason>". The actual API key lives on the client row, not here.
  fub_event_id: string | null;
  fub_pushed_at: string | null;
  fub_last_error: string | null;
  // Origin tag forwarded to FollowUpBoss as the event source.
  // "BrokerStaffer" = lead came from Nicole's intros (the historical
  // default, what every legacy row carries). "Client Entry" = lead
  // the client added themselves via the portal (manual form or CSV
  // upload). Backed by client_pipeline_entries.source (migration
  // 0054), non-null with a 'BrokerStaffer' default so the value is
  // safe to read everywhere without null-handling.
  source: string;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  title: string | null;
  phone: string | null;
  receives: "intro" | "digest" | "admin";
  active: boolean;
  avatar_url: string | null;
  // Legacy columns from when Team was a second blocklist. We don't
  // write them anymore but the rows still exist; kept on the type so
  // existing data deserialises cleanly. Safe to drop in a future
  // schema cleanup.
  pushed_to_instantly: boolean;
  pushed_to_emailbison: boolean;
  push_error: string | null;
  created_at: string;
}

export const STAGE_DESCRIPTIONS: Record<PipelineStage, string> = {
  introduction:
    "An agent has been introduced to you and initial contact has been made.",
  phone_screen_scheduled:
    "A phone screen has been booked with the agent — they haven't been screened yet.",
  phone_screen:
    "The phone screen has happened. You're evaluating the agent before moving to a full interview.",
  interview_scheduled:
    "An interview has been booked with the agent. The interview itself hasn't happened yet.",
  interview:
    "The interview has happened, or is being scheduled for an in-person / longer conversation.",
  hired: "The agent has accepted and is joining your team.",
  keep_warm:
    "The agent is interested but not ready to move forward yet. We stay in touch and re-engage at the right time.",
  we_they_rejected:
    "The agent was not a fit, the interview did not meet expectations, or the agent decided not to move forward.",
  no_show:
    "The agent did not attend the scheduled phone screen or interview.",
};

export const STAGE_ORDER: PipelineStage[] = [
  "introduction",
  "phone_screen_scheduled",
  "phone_screen",
  "interview_scheduled",
  "interview",
  "hired",
  "keep_warm",
  "we_they_rejected",
  "no_show",
];

export const DEFAULT_STAGE_LABELS: Record<PipelineStage, string> = {
  introduction: "Introduction",
  phone_screen_scheduled: "Phone Screen Scheduled",
  phone_screen: "Phone Screen",
  interview_scheduled: "Interview Scheduled",
  interview: "Interview",
  hired: "Hired",
  keep_warm: "Nurture",
  we_they_rejected: "Not a Fit",
  no_show: "No Response",
};

export const STAGE_LABEL_MAX_LEN = 40;

export function resolveStageLabels(
  overrides: Record<string, unknown> | null | undefined,
): Record<PipelineStage, string> {
  const merged: Record<PipelineStage, string> = { ...DEFAULT_STAGE_LABELS };
  if (!overrides || typeof overrides !== "object") return merged;
  for (const stage of STAGE_ORDER) {
    const raw = (overrides as Record<string, unknown>)[stage];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    merged[stage] = trimmed.slice(0, STAGE_LABEL_MAX_LEN);
  }
  return merged;
}

export function visibleStagesFor(
  client: { feature_flags?: Record<string, unknown> | null } | null | undefined,
): PipelineStage[] {
  const flags = client?.feature_flags;
  const hasInterviewScheduled =
    flags && typeof flags === "object"
      ? Boolean((flags as Record<string, unknown>).interview_scheduled_stage)
      : false;
  if (hasInterviewScheduled) return STAGE_ORDER;
  return STAGE_ORDER.filter((s) => s !== "interview_scheduled");
}

export function safeStageLabelsFor(
  fullLabels: Record<PipelineStage, string>,
  visibleStages: PipelineStage[],
): Record<PipelineStage, string> {
  const visible = new Set(visibleStages);
  const out = {} as Record<PipelineStage, string>;
  for (const stage of STAGE_ORDER) {
    out[stage] = visible.has(stage) ? fullLabels[stage] : stage;
  }
  return out;
}
