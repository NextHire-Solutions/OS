import { SettingsLabels } from "./settings-tabs/labels";
import { SettingsTemplates } from "./settings-tabs/templates";
import { SettingsReplyAgents } from "./settings-tabs/reply-agents";
import { SettingsAiLabeling } from "./settings-tabs/ai-labeling";
import { SettingsClients } from "./settings-tabs/clients";
import { SettingsMembers } from "./settings-tabs/members";
import { SettingsPersonal } from "./settings-tabs/personal";
import { SettingsWebhooks } from "./settings-tabs/webhooks";

/*
 * Master Inbox settings.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED HERE, AND WHY IT MATTERED
 *
 * This screen used to render the same data READ-ONLY: you could see the 21
 * labels and the 44 templates, and to change any of them you went back to the
 * old app. For a workspace whose purpose is to replace that app, a settings
 * page you cannot use is worse than no settings page — it looks finished.
 *
 * Each tab below is the tool's own settings page, ported with its editor
 * intact. Adding a label, editing a template, configuring a reply agent and
 * changing AI labelling all work here now.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE TAB LOADS AT A TIME
 *
 * The eight tabs together are eight independent sets of queries — labels,
 * templates, agents, AI config, clients, members, the personal profile and
 * webhooks. Rendering them all so that switching feels instant would make the
 * first paint pay for seven panels nobody asked for.
 *
 * The tab is a URL segment instead (`/inbox/settings/templates`), so only the
 * active panel loads, each tab is linkable, and the browser's Back button does
 * what it should.
 */

export const SETTINGS_TABS = [
  { id: "labels", label: "Labels" },
  { id: "templates", label: "Templates" },
  { id: "reply-agents", label: "Reply Agents" },
  { id: "ai-labeling", label: "AI Labeling" },
  { id: "clients", label: "Clients" },
  { id: "members", label: "Members" },
  { id: "personal", label: "Personal" },
  { id: "webhooks", label: "Webhooks" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/** Unknown tab → Labels, rather than a blank screen from a stale bookmark. */
export function isSettingsTab(value: string | undefined): value is SettingsTab {
  return SETTINGS_TABS.some((t) => t.id === value);
}

export async function MasterInboxSettingsScreen({ tab = "labels" }: { tab?: string }) {
  const active: SettingsTab = isSettingsTab(tab) ? tab : "labels";

  return (
    <div className="mi-theme">
      {/*
        The design's own pill row (`.fp` / `.fp.on`), not a Tailwind tab strip —
        this chrome sits in the OS shell alongside the mockup's screens, so it
        should look like them. The panels inside are the tool's.
      */}
      <div className="mi-settings-tabs">
        {SETTINGS_TABS.map((t) => (
          <a key={t.id} href={`/inbox/settings/${t.id}`} className={`fp${t.id === active ? " on" : ""}`}>
            {t.label}
          </a>
        ))}
      </div>

      <div className="mi-settings-body">
        {active === "labels" ? <SettingsLabels /> : null}
        {active === "templates" ? <SettingsTemplates /> : null}
        {active === "reply-agents" ? <SettingsReplyAgents /> : null}
        {active === "ai-labeling" ? <SettingsAiLabeling /> : null}
        {active === "clients" ? <SettingsClients /> : null}
        {active === "members" ? <SettingsMembers /> : null}
        {active === "personal" ? <SettingsPersonal /> : null}
        {active === "webhooks" ? <SettingsWebhooks /> : null}
      </div>
    </div>
  );
}
