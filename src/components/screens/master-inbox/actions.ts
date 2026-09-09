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

export interface Label {
  id: string;
  name: string;
  color: string | null;
  sentiment: string | null;
}

/*
 * The label list, fetched once and shared.
 *
 * Twenty-one labels that change a few times a year, wanted by every open
 * conversation. Re-fetching per thread would be a round trip for a list that
 * has not changed since the page loaded.
 */
let labelsPromise: Promise<Label[]> | null = null;

export function loadLabels(): Promise<Label[]> {
  if (labelsPromise) return labelsPromise;
  labelsPromise = fetch("/api/tools/master-inbox/labels", { credentials: "same-origin" })
    .then(async (res) => {
      const body = (await res.json()) as { labels?: Label[]; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `Failed (${res.status})`);
      return body.labels ?? [];
    })
    .catch((error) => {
      labelsPromise = null;
      throw error;
    });
  return labelsPromise;
}

/**
 * Applies a label, replacing whatever the thread had.
 *
 * Not a quiet write. Applying "Introduction" creates a row in that client's
 * live portal and notifies n8n, Slack and Follow Up Boss; "Interested" and
 * "Not Interested" round-trip to EmailBison; "Hostile" blacklists the lead.
 * The UI says so before the click, not after.
 */
export async function applyLabel(threadId: string, labelId: string): Promise<void> {
  const res = await fetch("/api/tools/master-inbox/labels", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread_id: threadId, label_id: labelId }),
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
}

export async function removeLabel(threadId: string, labelId: string): Promise<void> {
  const res = await fetch("/api/tools/master-inbox/labels", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread_id: threadId, label_id: labelId, op: "remove" }),
  });
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
}
