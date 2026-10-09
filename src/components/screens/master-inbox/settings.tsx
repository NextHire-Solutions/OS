import { SettingsLabels } from "./settings-tabs/labels";
import { SettingsTemplates } from "./settings-tabs/templates";
import { SettingsAiLabeling } from "./settings-tabs/ai-labeling";
/*
 * Webhooks is not offered in the workspace, at the user's request. The tab and
 * its panel are gone from the strip; the component and its route are left in
 * place so the tool's own copy still works and a future sync does not conflict.
 */
// import { SettingsWebhooks } from "./settings-tabs/webhooks";

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
 * intact. Adding a label, editing a template and changing AI labelling all
 * work here now.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE TAB LOADS AT A TIME
 *
 * The tabs together are independent sets of queries — labels, templates and
 * AI config. Rendering them all so that switching feels
 * instant would make the first paint pay for panels nobody asked for.
 *
 * 9 Oct (OS feedback): Members (logins for the old standalone inbox — OS
 * logins are on Team access) and Personal (a change-password form — the
 * Account page has the same one) were removed. So were Clients — renaming a
 * client's inbox row and its spellings moved to the client's record
 * (Clients → the client → Campaigns → In Master Inbox) — and Reply Agents,
 * whose editor moved to Admin → Reply agent. Their old addresses open Labels.
 *
 * The tab is a URL segment instead (`/inbox/settings/templates`), so only the
 * active panel loads, each tab is linkable, and the browser's Back button does
 * what it should.
 */

export const SETTINGS_TABS = [
  { id: "labels", label: "Labels" },
  { id: "templates", label: "Templates" },
  { id: "ai-labeling", label: "AI Labeling" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/** Unknown tab → Labels, rather than a blank screen from a stale bookmark. */
export function isSettingsTab(value: string | undefined): value is SettingsTab {
  return SETTINGS_TABS.some((t) => t.id === value);
}

/*
 * Workspace setup is for admins (5 Oct): AI Labeling. Teammates keep Labels
 * and Templates. The
 * APIs behind these tabs refuse a teammate too — hiding a tab is not the gate.
 */
const ADMIN_TABS = new Set<SettingsTab>(["ai-labeling"]);

export async function MasterInboxSettingsScreen({ tab = "labels", admin = false }: { tab?: string; admin?: boolean }) {
  const tabs = SETTINGS_TABS.filter((t) => admin || !ADMIN_TABS.has(t.id));
  const active: SettingsTab = isSettingsTab(tab) && tabs.some((t) => t.id === tab) ? tab : "labels";

  return (
    <div className="mi-theme">
      {/*
        The design's own pill row (`.fp` / `.fp.on`), not a Tailwind tab strip —
        this chrome sits in the OS shell alongside the mockup's screens, so it
        should look like them. The panels inside are the tool's.
      */}
      <div className="mi-settings-tabs">
        {tabs.map((t) => (
          <a key={t.id} href={`/inbox/settings/${t.id}`} className={`fp${t.id === active ? " on" : ""}`}>
            {t.label}
          </a>
        ))}
      </div>

      <div className="mi-settings-body">
        {active === "labels" ? <SettingsLabels /> : null}
        {active === "templates" ? <SettingsTemplates /> : null}
        {active === "ai-labeling" ? <SettingsAiLabeling /> : null}
      </div>
    </div>
  );
}
