/*
 * Settings › webhooks — the tool's own page, running here.
 *
 * A near-verbatim port of `app/(app)/settings/webhooks/page.tsx`. The only edits
 * are the import paths and the export name; the loaders, the copy and the
 * editor component are the tool's.
 *
 * These are the EDITORS. The OS previously showed this data read-only, which
 * meant anyone who needed to change a label, a template or an agent had to go
 * back to the old app — the thing this workspace exists to replace.
 */

import { SettingsPageShell, ComingSoon } from "@/components/master-inbox/settings/page-shell";
/*
 * A placeholder in the tool as well — `ComingSoon` is theirs, not a gap
 * introduced by the port. Kept so the tab exists and says the same thing the
 * live app says, rather than disappearing and looking like a lost feature.
 */
export function SettingsWebhooks() {
  return (
    <SettingsPageShell title="Webhooks" description="Outbound webhooks for label and reply events.">
      <ComingSoon name="Webhook subscriptions" />
    </SettingsPageShell>
  );
}
