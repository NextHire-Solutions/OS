import { createAdminSupabase } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import type { AiProvider } from "./label";

export interface AiLabelingConfig {
  workspace_id: string;
  enabled: boolean;
  provider: AiProvider;
  has_api_key: boolean;
  model: string;
  label_old_replies: boolean;
  relabel_ongoing: boolean;
  use_custom_prompt: boolean;
  custom_prompt: string | null;
  category_set: string[];
  last_run_at: string | null;
}

// Reads the labeling config and returns the decrypted API key. Uses the
// service-role client + pgcrypto pgp_sym_decrypt with APP_ENCRYPTION_KEY.
// Returns null if the workspace has no config row or no key set.
export async function loadAiConfigWithKey(workspaceId: string): Promise<
  (AiLabelingConfig & { api_key: string | null }) | null
> {
  const key = env.APP_ENCRYPTION_KEY;
  if (!key) return null;
  const admin = createAdminSupabase();
  // Inline decryption via SQL so the raw bytea never leaves Postgres.
  const { data, error } = await admin.rpc("ai_labeling_decrypt", {
    p_workspace: workspaceId,
    p_key: key,
  });
  if (error) {
    console.error("[ai] loadAiConfigWithKey rpc failed", error);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    workspace_id: row.workspace_id,
    enabled: row.enabled,
    provider: row.provider,
    has_api_key: Boolean(row.api_key),
    api_key: row.api_key ?? null,
    model: row.model,
    label_old_replies: row.label_old_replies,
    relabel_ongoing: row.relabel_ongoing,
    use_custom_prompt: row.use_custom_prompt,
    custom_prompt: row.custom_prompt,
    category_set: row.category_set ?? [],
    last_run_at: row.last_run_at,
  };
}

// Read-only (for the settings UI). Returns the config without the api_key,
// just a boolean indicating whether one is configured.
export async function loadAiConfig(workspaceId: string): Promise<AiLabelingConfig | null> {
  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("ai_labeling_config")
    .select(
      "workspace_id, enabled, provider, model, label_old_replies, relabel_ongoing, use_custom_prompt, custom_prompt, category_set, last_run_at, api_key_encrypted",
    )
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    workspace_id: data.workspace_id,
    enabled: data.enabled,
    provider: data.provider as AiProvider,
    has_api_key: Boolean(data.api_key_encrypted),
    model: data.model,
    label_old_replies: data.label_old_replies,
    relabel_ongoing: data.relabel_ongoing,
    use_custom_prompt: data.use_custom_prompt,
    custom_prompt: data.custom_prompt,
    category_set: data.category_set ?? [],
    last_run_at: data.last_run_at,
  };
}

export interface SaveAiConfigInput {
  workspaceId: string;
  enabled?: boolean;
  provider?: AiProvider;
  apiKey?: string | null; // null to clear, undefined to keep
  model?: string;
  label_old_replies?: boolean;
  relabel_ongoing?: boolean;
  use_custom_prompt?: boolean;
  custom_prompt?: string | null;
  category_set?: string[];
}

export async function saveAiConfig(input: SaveAiConfigInput): Promise<void> {
  const admin = createAdminSupabase();
  const key = env.APP_ENCRYPTION_KEY;

  // Build an UPDATE row. For the API key we use pgcrypto via a custom rpc so
  // we can encrypt server-side without round-tripping plaintext through the
  // JSON-only PostgREST client.
  const update: Record<string, unknown> = {};
  if (input.enabled !== undefined) update.enabled = input.enabled;
  if (input.provider) update.provider = input.provider;
  if (input.model) update.model = input.model;
  if (input.label_old_replies !== undefined) update.label_old_replies = input.label_old_replies;
  if (input.relabel_ongoing !== undefined) update.relabel_ongoing = input.relabel_ongoing;
  if (input.use_custom_prompt !== undefined) update.use_custom_prompt = input.use_custom_prompt;
  if (input.custom_prompt !== undefined) update.custom_prompt = input.custom_prompt;
  if (input.category_set !== undefined) update.category_set = input.category_set;
  if (input.apiKey === null) update.api_key_encrypted = null;

  if (Object.keys(update).length > 0) {
    const { error: upsertErr } = await admin
      .from("ai_labeling_config")
      .upsert({ workspace_id: input.workspaceId, ...update }, { onConflict: "workspace_id" });
    if (upsertErr) throw new Error(upsertErr.message);
  }

  if (input.apiKey && input.apiKey.length > 0) {
    if (!key) throw new Error("APP_ENCRYPTION_KEY is not configured on the server.");
    const { error: encErr } = await admin.rpc("ai_labeling_set_key", {
      p_workspace: input.workspaceId,
      p_key: key,
      p_plaintext: input.apiKey,
    });
    if (encErr) throw new Error(encErr.message);
  }
}
