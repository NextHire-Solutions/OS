import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";

import { applyLabelToThread } from "../inbox/apply-label";

/*
 * The conversation labelled Introduction after its hand-off went (handoff-introduction.ts): the same guarded function
 * the labels route, the reply agent and the lead caps use, so every consequence of the label happens exactly as when a
 * person applies it, and an Introduction already carried is never announced again.
 */
export async function labelIntroduction(workspaceId: string, threadId: string): Promise<{ ok: true; announced: boolean } | { ok: false; error: string }> {
  const sb = createAdminSupabase();
  const { data, error } = await sb.from("labels").select("id").eq("workspace_id", workspaceId).ilike("name", "introduction").maybeSingle();
  if (error) return { ok: false, error: `labels: ${error.message}` };
  const labelId = (data as { id?: string } | null)?.id;
  if (!labelId) return { ok: false, error: "there is no Introduction label in this workspace" };
  const r = await applyLabelToThread({ supabase: sb, workspaceId, threadId, labelId, actor: { kind: "agent", agentId: "brokerage hand-off" } });
  return r.ok ? { ok: true, announced: r.announced } : { ok: false, error: r.error };
}
