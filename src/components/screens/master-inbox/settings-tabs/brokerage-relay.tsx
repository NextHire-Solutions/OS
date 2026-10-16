/*
 * Settings › Brokerage hand-off — Interested replies → the brokerage, by
 * Postmark (lib/tools/master-inbox/relay/). Admins only: the tab is listed in
 * ADMIN_TABS and every route behind it refuses a non-admin too.
 */

import { SettingsPageShell } from "@/components/master-inbox/settings/page-shell";
import { BrokerageRelaySettings } from "@/components/master-inbox/settings/brokerage-relay-settings";
import { relayOverview } from "@/lib/tools/master-inbox/relay/relay";

export async function SettingsBrokerageRelay() {
  let overview;
  try {
    overview = await relayOverview();
  } catch (e) {
    return (
      <SettingsPageShell title="Brokerage hand-off">
        <p className="mis-err">Could not read the hand-off: {e instanceof Error ? e.message : String(e)}</p>
      </SettingsPageShell>
    );
  }
  return (
    <SettingsPageShell
      title="Brokerage hand-off"
      description="When a reply is marked Interested (or Meetings Booked), the agent's own reply goes to the right people at the brokerage their campaign belongs to — from “Agent via BrokerStaffer”, replies straight to the agent. Starts in practice: everything is checked and recorded, nothing is sent."
    >
      <BrokerageRelaySettings initial={overview} />
    </SettingsPageShell>
  );
}
