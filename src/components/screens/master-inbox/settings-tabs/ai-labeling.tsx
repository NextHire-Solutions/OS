/*
 * Settings › ai-labeling — the tool's own page, running here.
 *
 * A near-verbatim port of `app/(app)/settings/ai-labeling/page.tsx`. The only edits
 * are the import paths and the export name; the loaders, the copy and the
 * editor component are the tool's.
 *
 * These are the EDITORS. The OS previously showed this data read-only, which
 * meant anyone who needed to change a label, a template or an agent had to go
 * back to the old app — the thing this workspace exists to replace.
 */

import { SettingsPageShell } from "@/components/master-inbox/settings/page-shell";
import { AiLabelingForm } from "@/components/master-inbox/settings/ai-labeling-form";
import { requireSession } from "@/lib/auth/workspace";
import { loadAiConfig } from "@/lib/tools/master-inbox/ai/config";
import { loadLabels } from "@/lib/tools/master-inbox/inbox/labels";


export async function SettingsAiLabeling() {
  const session = await requireSession();
  const [config, labels] = await Promise.all([
    loadAiConfig(session.activeWorkspace.id),
    loadLabels(session.activeWorkspace.id),
  ]);

  return (
    <SettingsPageShell
      title="AI Labeling"
      description="Auto-label inbound replies using an AI provider. Pick a provider, paste an API key, and choose which of your labels the model can apply."
    >
      <AiLabelingForm initial={config} labels={labels} />
    </SettingsPageShell>
  );
}
