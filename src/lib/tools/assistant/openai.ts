import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { env } from "@/lib/tools/master-inbox/env";

import { TOOL_SCHEMA, type ModelFn, type ModelMessage, type ModelReply } from "./engine.ts";

/*
 * The OpenAI call, and where its key comes from.
 *
 * THE KEY IS THE WORKSPACE'S, not a new one. `ai_labeling_config` already
 * holds an encrypted OpenAI key for this workspace, decrypted inside Postgres
 * by `ai_labeling_decrypt` so the raw bytes never leave the database. Adding a
 * second key in an env var would mean two places to rotate and one of them
 * forgotten.
 *
 * Deliberately NOT the reply agent's key: that one belongs to an agent which
 * can be paused, renamed or deleted, and the assistant would stop working for
 * a reason nobody would connect to it.
 */

export class NoAssistantKeyError extends Error {
  constructor(why: string) {
    super(
      `The assistant has no OpenAI key: ${why}. It uses the workspace key from ` +
        `Master Inbox → Settings → AI Labeling. Set it there, and make sure ` +
        `APP_ENCRYPTION_KEY is set on this server.`,
    );
    this.name = "NoAssistantKeyError";
  }
}

export async function loadAssistantKey(workspaceId: string): Promise<{ apiKey: string; model: string }> {
  /*
   * A direct key, for development.
   *
   * The stored key is decrypted inside Postgres with APP_ENCRYPTION_KEY, which
   * is set on the servers and deliberately not on a laptop — so without this
   * escape hatch the assistant cannot be run locally at all, and the only way
   * to try a change is to deploy it.
   *
   * Production leaves it unset and uses the workspace key, so there is still
   * one key to rotate in the place people already rotate it.
   */
  const direct = process.env.ASSISTANT_OPENAI_API_KEY;
  if (direct) return { apiKey: direct, model: process.env.ASSISTANT_MODEL ?? "gpt-4o" };

  const encryptionKey = env.APP_ENCRYPTION_KEY;
  if (!encryptionKey) throw new NoAssistantKeyError("APP_ENCRYPTION_KEY is not set on this server");

  const admin = createAdminSupabase();
  const { data, error } = await admin.rpc("ai_labeling_decrypt", {
    p_workspace: workspaceId,
    p_key: encryptionKey,
  });
  if (error) throw new NoAssistantKeyError(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  const apiKey = (row as { api_key?: string } | null)?.api_key;
  if (!apiKey) throw new NoAssistantKeyError("no key is stored for this workspace");

  /*
   * A bigger model than the labeller's gpt-4o-mini, on purpose. This is
   * multi-step tool work over four products, where the cost of choosing the
   * wrong tool or misreading a null is a confidently wrong answer about a
   * client — a different failure from mislabelling one reply.
   */
  return { apiKey, model: "gpt-4o" };
}

export function openAiModel(apiKey: string, model: string): ModelFn {
  return async (messages: ModelMessage[]): Promise<ModelReply> => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        tools: TOOL_SCHEMA,
        tool_choice: "auto",
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`OpenAI ${res.status}: ${detail.slice(0, 300)}`);
    }

    const body = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const message = body.choices?.[0]?.message;
    return {
      content: message?.content ?? null,
      toolCalls: (message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      })),
      tokensPrompt: body.usage?.prompt_tokens ?? 0,
      tokensCompletion: body.usage?.completion_tokens ?? 0,
    };
  };
}
