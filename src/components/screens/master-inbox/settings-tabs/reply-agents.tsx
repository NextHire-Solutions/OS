/*
 * Settings › reply-agents — the tool's own page, running here.
 *
 * A near-verbatim port of `app/(app)/settings/reply-agents/page.tsx`. The only edits
 * are the import paths and the export name; the loaders, the copy and the
 * editor component are the tool's.
 *
 * These are the EDITORS. The OS previously showed this data read-only, which
 * meant anyone who needed to change a label, a template or an agent had to go
 * back to the old app — the thing this workspace exists to replace.
 */

import { SettingsPageShell } from "@/components/master-inbox/settings/page-shell";
import { ReplyAgentsManager } from "@/components/master-inbox/settings/reply-agents-manager";
import { requireSession } from "@/lib/auth/workspace";
import { loadAgents } from "@/lib/tools/master-inbox/ai/agent";


export async function SettingsReplyAgents() {
  const session = await requireSession();
  const agents = await loadAgents(session.activeWorkspace.id);

  return (
    <SettingsPageShell
      title="Reply Agents"
      description="Configure AI agents that draft replies for you. Human-in-the-loop drafts surface in the composer; auto-respond agents send directly."
    >
      <ReplyAgentsManager agents={agents} />
    </SettingsPageShell>
  );
}
