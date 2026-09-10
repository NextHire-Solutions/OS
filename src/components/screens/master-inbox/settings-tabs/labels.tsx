/*
 * Settings › labels — the tool's own page, running here.
 *
 * A near-verbatim port of `app/(app)/settings/labels/page.tsx`. The only edits
 * are the import paths and the export name; the loaders, the copy and the
 * editor component are the tool's.
 *
 * These are the EDITORS. The OS previously showed this data read-only, which
 * meant anyone who needed to change a label, a template or an agent had to go
 * back to the old app — the thing this workspace exists to replace.
 */

import { SettingsPageShell } from "@/components/master-inbox/settings/page-shell";
import { LabelsManager } from "@/components/master-inbox/settings/labels-manager";
import { requireSession } from "@/lib/auth/workspace";
import { loadLabels } from "@/lib/tools/master-inbox/inbox/labels";


export async function SettingsLabels() {
  const session = await requireSession();
  const labels = await loadLabels(session.activeWorkspace.id);

  return (
    <SettingsPageShell
      title="Label Management"
      description="Curate the labels applied to inbound replies. System labels seed every workspace; custom labels are yours to define."
    >
      <LabelsManager labels={labels} />
    </SettingsPageShell>
  );
}
