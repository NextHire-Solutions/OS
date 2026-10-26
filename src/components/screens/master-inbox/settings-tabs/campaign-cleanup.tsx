/*
 * Settings › Campaign clean-up — My Agents and DNC people off the client's own
 * campaigns (lib/clients/campaign-lists/). Admins only: the tab is listed in
 * ADMIN_TABS and every route behind it refuses a non-admin too.
 */

import { SettingsPageShell } from "@/components/master-inbox/settings/page-shell";
import { CampaignCleanupSettings } from "@/components/master-inbox/settings/campaign-cleanup-settings";
import { cleanupOverview } from "@/lib/clients/campaign-lists/sweep";

export async function SettingsCampaignCleanup() {
  let overview;
  try {
    overview = await cleanupOverview();
  } catch (e) {
    return (
      <SettingsPageShell title="Campaign clean-up">
        <p className="mis-err">Could not read the clean-up: {e instanceof Error ? e.message : String(e)}</p>
      </SettingsPageShell>
    );
  }
  return (
    <SettingsPageShell
      title="Campaign clean-up"
      description="When a portal adds someone to My Agents or DNC, take them off that client's own EmailBison campaigns. Starts in practice: everything is looked up and recorded, nothing is removed."
    >
      <CampaignCleanupSettings initial={overview} />
    </SettingsPageShell>
  );
}
