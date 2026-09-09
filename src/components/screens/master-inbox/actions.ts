"use client";

/*
 * Thread actions, from the browser.
 *
 * Every one goes to a workspace API route, which writes to Master Inbox's own
 * database scoped by workspace and by an explicit id list. The browser holds
 * no database credential.
 *
 * Labelling is not here. It fires an n8n webhook, a Follow Up Boss push, a
 * Slack notice and an EmailBison interest call, and creates a row in the
 * client's LIVE portal — so it lands as its own change with its own testing.
 */

export type ThreadStatus = "open" | "archived" | "trash" | "spam" | "reminder";

async function post(body: unknown): Promise<void> {
  const res = await fetch("/api/tools/master-inbox/threads", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(parsed?.error ?? `Request failed (${res.status})`);
}

/** Moves threads between views. "Delete" is a move to trash, as in the tool. */
export function setStatus(threadIds: string[], status: ThreadStatus): Promise<void> {
  return post({ action: "status", thread_ids: threadIds, status });
}

export function setSeen(threadIds: string[], seen: boolean): Promise<void> {
  return post({ action: "seen", thread_ids: threadIds, seen });
}
