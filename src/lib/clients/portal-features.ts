/*
 * The feature flags a NEW client's portal should launch with.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OS HAS TO DO THIS AT ALL
 *
 * Master Inbox's own `POST /api/clients` seeds three flags — manage_stages,
 * pipeline_kanban_view and pipeline_board_enhanced. That was the complete set
 * when the route was written. Six more have shipped since, and each was rolled
 * out by updating existing clients, so the CREATE path was never updated to
 * match.
 *
 * The result is measurable rather than theoretical. Of 60 Master Inbox clients,
 * 52 carry all nine flags and 7 carry only the original three — and those 7 are
 * exactly the ones created through the API since the rollout: Cain Realty
 * Group, JPAR Iron Horse, Norvell&Co, Oz Group, Wagner Real Estate Group, "New
 * client portal", and the OpsLabs test client.
 *
 * What that costs a real client: no product tour, no plan shown in the portal,
 * no CSV upload into the pipeline, no source split, no integrations label, and
 * no "Interview scheduled" stage. The portal works, but it is a 2024 portal.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SET IS WRITTEN OUT RATHER THAN COPIED FROM ANOTHER CLIENT
 *
 * Copying the flags off some existing client would make onboarding depend on
 * whichever row happened to be picked, and would silently propagate anything
 * odd about it. `ideal_agent_profile` is the case in point: exactly ONE client
 * has it, so it is plainly a trial rather than a default, and it is deliberately
 * not in this list.
 *
 * When Master Inbox adds a flag, this list is the one place to update — and the
 * adoption query in the comment above is how to tell that it needs updating.
 */

export type PortalFeatureFlags = Record<string, boolean>;

/**
 * Seeded on create. Matches the 52-of-60 majority exactly.
 *
 * The first three are already set by Master Inbox's own route; they are
 * repeated here so this list reads as the complete answer to "what should a new
 * portal have", rather than "the extras nobody else sets".
 */
export const STANDARD_PORTAL_FLAGS: PortalFeatureFlags = {
  manage_stages: true,
  pipeline_kanban_view: true,
  pipeline_board_enhanced: true,
  portal_tour: true,
  show_client_plan: true,
  pipeline_csv_upload: true,
  pipeline_source_split: true,
  nav_integrations_label: true,
  interview_scheduled_stage: true,
};

/**
 * Merge the standard set over whatever the client already has.
 *
 * Existing keys are preserved rather than reset, including any set to `false`
 * ON PURPOSE — turning a flag off for one client is a real thing someone may
 * have done, and onboarding a client twice must not silently undo it. Only
 * flags that are ABSENT get added.
 */
export function withStandardFlags(existing: unknown): PortalFeatureFlags {
  const current: PortalFeatureFlags =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as PortalFeatureFlags) }
      : {};
  for (const [key, value] of Object.entries(STANDARD_PORTAL_FLAGS)) {
    if (!(key in current)) current[key] = value;
  }
  return current;
}

/** Flags the standard set expects that a client does not have. */
export function missingFlags(existing: unknown): string[] {
  const current =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as PortalFeatureFlags)
      : {};
  return Object.keys(STANDARD_PORTAL_FLAGS).filter((k) => !current[k]);
}
