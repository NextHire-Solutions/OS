/*
 * Which connector actions exist at all (25 Nov): OS_MCP_ACTIONS, a comma list of action names, e.g.
 * "inbox_set_label,inbox_snooze,client_campaigns". Unset or empty: none — the connector is exactly as read-only as
 * before. Each action can be switched on (and off again) alone, with a restart, no deploy.
 */
export const ACTION_NAMES = [
  "inbox_set_label", "inbox_snooze", "client_campaigns", "inbox_introduce", "inbox_reply",
  "campaign_pause", "campaign_start", "campaign_limits", "campaign_add_inboxes", "campaign_edit_copy",
  "campaign_create", "campaign_add_agents",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export function enabledActions(env: Record<string, string | undefined> = process.env): Set<ActionName> {
  const raw = (env.OS_MCP_ACTIONS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set(ACTION_NAMES.filter((n) => raw.includes(n)));
}
