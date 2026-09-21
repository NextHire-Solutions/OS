import "server-only";

import { osTable } from "@/lib/clients/os-db";

import type { ToolCall } from "./engine.ts";

/*
 * Stored conversations.
 *
 * EVERY READ IS SCOPED BY user_email, in the query rather than after it. These
 * chats contain every client's figures, and the person who asked is the only
 * one who should see their own history. A filter applied in JavaScript after
 * fetching is one forgotten line away from being no filter at all, so the
 * scope travels with the query on every call below.
 */

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  toolCalls: ToolCall[];
  createdAt: string;
  error: string | null;
}

export async function listChats(userEmail: string, limit = 60): Promise<ChatSummary[]> {
  const { data } = await osTable("os_assistant_chats")
    .select("id, title, updated_at")
    .eq("user_email", userEmail)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    title: String(r.title ?? "New chat"),
    updatedAt: String(r.updated_at),
  }));
}

export async function createChat(userEmail: string): Promise<ChatSummary> {
  const { data, error } = await osTable("os_assistant_chats")
    .insert({ user_email: userEmail })
    .select("id, title, updated_at")
    .single();
  if (error) throw new Error(`Could not start a chat: ${error.message}`);
  const row = data as Record<string, unknown>;
  return { id: String(row.id), title: String(row.title), updatedAt: String(row.updated_at) };
}

/** Null when the chat does not exist OR belongs to someone else — the same answer on purpose. */
export async function getChat(
  userEmail: string,
  chatId: string,
): Promise<{ chat: ChatSummary; messages: StoredMessage[] } | null> {
  const { data: chatRow } = await osTable("os_assistant_chats")
    .select("id, title, updated_at")
    .eq("id", chatId)
    .eq("user_email", userEmail)
    .is("deleted_at", null)
    .maybeSingle();
  if (!chatRow) return null;

  const { data: messageRows } = await osTable("os_assistant_messages")
    .select("id, role, content, tool_calls, created_at, error")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(400);

  const row = chatRow as Record<string, unknown>;
  return {
    chat: { id: String(row.id), title: String(row.title), updatedAt: String(row.updated_at) },
    messages: ((messageRows ?? []) as Array<Record<string, unknown>>).map((m) => ({
      id: Number(m.id),
      role: m.role as "user" | "assistant",
      content: String(m.content ?? ""),
      toolCalls: (m.tool_calls as ToolCall[]) ?? [],
      createdAt: String(m.created_at),
      error: (m.error as string) ?? null,
    })),
  };
}

export async function appendMessage(input: {
  chatId: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  tokensPrompt?: number;
  tokensCompletion?: number;
  error?: string | null;
}): Promise<void> {
  await osTable("os_assistant_messages").insert({
    chat_id: input.chatId,
    role: input.role,
    content: input.content,
    tool_calls: input.toolCalls ?? [],
    tokens_prompt: input.tokensPrompt ?? null,
    tokens_completion: input.tokensCompletion ?? null,
    error: input.error ?? null,
  });
  await osTable("os_assistant_chats")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", input.chatId);
}

/**
 * The sidebar title, taken from the first question.
 *
 * Written only while the chat is still called "New chat", so a title someone
 * typed themselves is never overwritten by their next question.
 */
export async function titleFromFirstQuestion(chatId: string, question: string): Promise<string | null> {
  const title = question.trim().replace(/\s+/g, " ").slice(0, 72) || "New chat";
  const { data } = await osTable("os_assistant_chats")
    .update({ title })
    .eq("id", chatId)
    .eq("title", "New chat")
    .select("title")
    .maybeSingle();
  return data ? title : null;
}

export async function renameChat(userEmail: string, chatId: string, title: string): Promise<boolean> {
  const clean = title.trim().slice(0, 120);
  if (!clean) return false;
  const { data } = await osTable("os_assistant_chats")
    .update({ title: clean })
    .eq("id", chatId)
    .eq("user_email", userEmail)
    .select("id")
    .maybeSingle();
  return Boolean(data);
}

/**
 * Soft delete: the row stays, `deleted_at` is set.
 *
 * The messages hold what was asked and what was answered about real clients.
 * A hard delete would also drop the token counts that explain a month's spend,
 * and there is no undo on a chat someone removed by mistake.
 */
export async function deleteChat(userEmail: string, chatId: string): Promise<boolean> {
  const { data } = await osTable("os_assistant_chats")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", chatId)
    .eq("user_email", userEmail)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  return Boolean(data);
}
