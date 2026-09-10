import { createAdminSupabase } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { generateReplyDraft, DEFAULT_REPLY_SYSTEM_PROMPT, type ConversationTurn } from "@/lib/tools/master-inbox/ai/reply";
import type { AiProvider } from "@/lib/tools/master-inbox/ai/label";

export type ChannelFilter = "email" | "both";

export interface ReplyAgent {
  id: string;
  workspace_id: string;
  name: string;
  mode: "human_in_loop" | "auto";
  tone: string;
  response_length: "short" | "medium" | "long" | "variable";
  max_tokens: number;
  temperature: number;
  provider: AiProvider;
  model: string;
  has_api_key: boolean;
  system_prompt: string | null;
  channel_ids: string[];
  channel_filter: ChannelFilter;
  active: boolean;
  auto_respond_new: boolean;
  stats: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function loadAgents(workspaceId: string): Promise<ReplyAgent[]> {
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("reply_agents")
    .select(
      "id, workspace_id, name, mode, tone, response_length, max_tokens, temperature, provider, model, api_key_encrypted, system_prompt, channel_ids, channel_filter, active, auto_respond_new, stats, created_at, updated_at",
    )
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[agents] loadAgents failed", error);
    return [];
  }
  return (data ?? []).map((row) => ({
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    name: row.name as string,
    mode: row.mode as "human_in_loop" | "auto",
    tone: row.tone as string,
    response_length: (row.response_length as "short" | "medium" | "long" | "variable") ?? "medium",
    max_tokens: row.max_tokens as number,
    temperature: Number(row.temperature),
    provider: row.provider as AiProvider,
    model: row.model as string,
    has_api_key: Boolean(row.api_key_encrypted),
    system_prompt: (row.system_prompt as string | null) ?? null,
    channel_ids: (row.channel_ids as string[]) ?? [],
    channel_filter: ((row.channel_filter as ChannelFilter | null) ?? "both") as ChannelFilter,
    active: row.active as boolean,
    auto_respond_new: row.auto_respond_new as boolean,
    stats: (row.stats as Record<string, unknown>) ?? {},
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }));
}

// Decrypt the agent's API key using the same pgcrypto helpers we use for
// the AI labeling config. Returns the agent row joined with the decrypted
// key, or null if the workspace isn't configured.
export async function loadAgentWithKey(
  agentId: string,
): Promise<(ReplyAgent & { api_key: string | null }) | null> {
  const key = env.APP_ENCRYPTION_KEY;
  if (!key) return null;
  const admin = createAdminSupabase();
  const { data, error } = await admin.rpc("reply_agent_decrypt", {
    p_agent: agentId,
    p_key: key,
  });
  if (error) {
    console.error("[agents] reply_agent_decrypt failed", error);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    mode: row.mode,
    tone: row.tone,
    response_length: (row.response_length as "short" | "medium" | "long" | "variable") ?? "medium",
    max_tokens: row.max_tokens,
    temperature: Number(row.temperature),
    provider: row.provider,
    model: row.model,
    has_api_key: Boolean(row.api_key),
    api_key: row.api_key ?? null,
    system_prompt: row.system_prompt,
    channel_ids: row.channel_ids ?? [],
    channel_filter: (row.channel_filter ?? "both") as ChannelFilter,
    active: row.active,
    auto_respond_new: row.auto_respond_new,
    stats: row.stats ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface SaveAgentInput {
  workspaceId: string;
  id?: string;
  name?: string;
  mode?: "human_in_loop" | "auto";
  tone?: string;
  response_length?: "short" | "medium" | "long" | "variable";
  max_tokens?: number;
  temperature?: number;
  provider?: AiProvider;
  model?: string;
  apiKey?: string | null; // null to clear, undefined to keep
  system_prompt?: string | null;
  channel_ids?: string[];
  channel_filter?: ChannelFilter;
  active?: boolean;
  auto_respond_new?: boolean;
}

export async function saveAgent(input: SaveAgentInput): Promise<string> {
  const admin = createAdminSupabase();
  const key = env.APP_ENCRYPTION_KEY;

  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.mode !== undefined) update.mode = input.mode;
  if (input.tone !== undefined) update.tone = input.tone;
  if (input.response_length !== undefined) update.response_length = input.response_length;
  if (input.max_tokens !== undefined) update.max_tokens = input.max_tokens;
  if (input.temperature !== undefined) update.temperature = input.temperature;
  if (input.provider !== undefined) update.provider = input.provider;
  if (input.model !== undefined) update.model = input.model;
  if (input.system_prompt !== undefined) update.system_prompt = input.system_prompt;
  if (input.channel_ids !== undefined) update.channel_ids = input.channel_ids;
  if (input.channel_filter !== undefined) update.channel_filter = input.channel_filter;
  if (input.active !== undefined) update.active = input.active;
  if (input.auto_respond_new !== undefined) update.auto_respond_new = input.auto_respond_new;
  if (input.apiKey === null) update.api_key_encrypted = null;

  let agentId = input.id;
  if (agentId) {
    const { error } = await admin
      .from("reply_agents")
      .update(update)
      .eq("id", agentId)
      .eq("workspace_id", input.workspaceId);
    if (error) throw new Error(error.message);
  } else {
    if (!input.name) throw new Error("Name is required for new agents");
    const { data, error } = await admin
      .from("reply_agents")
      .insert({
        workspace_id: input.workspaceId,
        name: input.name,
        ...update,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    agentId = data.id;
  }

  if (input.apiKey && input.apiKey.length > 0 && agentId) {
    if (!key) throw new Error("APP_ENCRYPTION_KEY is not configured on the server.");
    const { error: encErr } = await admin.rpc("reply_agent_set_key", {
      p_agent: agentId,
      p_key: key,
      p_plaintext: input.apiKey,
    });
    if (encErr) throw new Error(encErr.message);
  }

  return agentId!;
}

export async function deleteAgent(workspaceId: string, agentId: string): Promise<void> {
  const admin = createAdminSupabase();
  const { error } = await admin
    .from("reply_agents")
    .delete()
    .eq("id", agentId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
}

interface DraftContext {
  workspaceId: string;
  threadId: string;
  agent: ReplyAgent & { api_key: string | null };
  leadName: string | null;
  leadEmail: string | null;
  ourName: string | null;
  ourEmail: string | null;
  subject: string | null;
  // Full thread, oldest → newest. The last entry must be the most recent
  // inbound message — what the draft is replying to.
  conversation: ConversationTurn[];
}

export type CreateDraftResult =
  | { status: "ok"; draftId: string; body: string }
  | { status: "no_key" }
  | { status: "insert_failed"; error: string }
  | { status: "ai_failed"; draftId: string; error: string };

// Generate + persist a draft. Returns a discriminated result so callers
// can surface the actual reason if drafting fails (provider 401, model
// timeout, etc.). All failures are also persisted on the reply_drafts
// row with status='rejected' + error_message.
export async function createDraftForAgent(ctx: DraftContext): Promise<CreateDraftResult> {
  if (!ctx.agent.api_key) return { status: "no_key" };
  const admin = createAdminSupabase();

  const { data: draftRow, error: insErr } = await admin
    .from("reply_drafts")
    .insert({
      workspace_id: ctx.workspaceId,
      thread_id: ctx.threadId,
      agent_id: ctx.agent.id,
      status: "pending",
    })
    .select("id")
    .single();
  if (insErr || !draftRow) {
    console.error("[agents] failed to create draft placeholder", insErr);
    return { status: "insert_failed", error: insErr?.message ?? "Insert failed" };
  }
  const draftId = draftRow.id as string;

  try {
    const result = await generateReplyDraft({
      provider: ctx.agent.provider,
      apiKey: ctx.agent.api_key,
      model: ctx.agent.model,
      systemPrompt:
        ctx.agent.system_prompt && ctx.agent.system_prompt.trim().length > 0
          ? ctx.agent.system_prompt
          : DEFAULT_REPLY_SYSTEM_PROMPT,
      tone: ctx.agent.tone,
      responseLength: ctx.agent.response_length,
      temperature: ctx.agent.temperature,
      maxTokens: ctx.agent.max_tokens,
      leadName: ctx.leadName,
      leadEmail: ctx.leadEmail,
      ourName: ctx.ourName,
      ourEmail: ctx.ourEmail,
      subject: ctx.subject,
      conversation: ctx.conversation,
    });

    await admin
      .from("reply_drafts")
      .update({
        generated_body: result.body,
        tokens_prompt: result.tokensPrompt,
        tokens_completion: result.tokensCompletion,
      })
      .eq("id", draftId);

    return { status: "ok", draftId, body: result.body };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown draft error";
    console.error("[agents] generateReplyDraft failed", message);
    await admin
      .from("reply_drafts")
      .update({ status: "rejected", error_message: message })
      .eq("id", draftId);
    return { status: "ai_failed", draftId, error: message };
  }
}
