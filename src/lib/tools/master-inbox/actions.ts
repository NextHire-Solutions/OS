import "server-only";

import { chunkedRun } from "./db/chunked-in";
import { getMasterInboxSupabase, workspaceId } from "./supabase";

/*
 * Master Inbox — thread actions.
 *
 * A port of the tool's `/api/threads/bulk` branches, writing to the same
 * database. Not a proxy: the workspace IS the staff inbox now, and the live
 * service is kept for the client portals, the provider webhooks and the crons.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THESE SAFE
 *
 *   every write is scoped by workspace_id AND by an explicit id list. There is
 *   no code path here that updates a table without both.
 *
 *   `chunkedRun` is the tool's own helper and is kept for the reason its
 *   comments give: thousands of UUIDs in one `.in()` overflow the request and
 *   fail in a way that looks like nothing happening.
 *
 *   `clients` is never touched. Portals resolve on three of its columns and
 *   `portal-guard.ts` refuses them; these actions only write `threads`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE YET, AND WHY
 *
 * Labelling is deliberately absent from this file. In the tool it fires four
 * external systems — an n8n webhook, a Follow Up Boss push, a Slack notice and
 * an EmailBison interest call — and creates a pipeline row that appears in the
 * client's LIVE portal. Those modules are copied and ready, but labelling
 * lands as its own change with its own testing rather than riding along with
 * archive.
 *
 * `assigned_user_id` and friends stay null, which is what every existing row
 * already has — so these writes are indistinguishable from the tool's own.
 */

export type ThreadStatus = "open" | "archived" | "trash" | "spam" | "reminder";

export interface ActionResult {
  ok: boolean;
  updated: number;
  error?: string;
}

/** Ids must be UUIDs — they are interpolated into a PostgREST filter. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tool's own cap. 500 at a time, so one action cannot walk the table. */
const MAX_IDS = 500;

function validate(threadIds: string[]): string[] {
  const ids = threadIds.filter((id) => UUID.test(id));
  if (ids.length === 0) throw new Error("No valid thread ids");
  if (ids.length > MAX_IDS) throw new Error(`At most ${MAX_IDS} threads at a time`);
  return ids;
}

/**
 * Moves threads between open, archived, trash, spam and reminder.
 *
 * The tool treats "delete" as a move to trash rather than a removal, and so
 * does this — permanent deletion is a separate, operator-confirmed action in
 * the tool and is not ported.
 */
export async function setThreadStatus(
  threadIds: string[],
  status: ThreadStatus,
): Promise<ActionResult> {
  try {
    const ids = validate(threadIds);
    const ws = await workspaceId();
    const sb = getMasterInboxSupabase();

    const results = await chunkedRun(ids, (slice) =>
      sb.from("threads").update({ status }).in("id", slice).eq("workspace_id", ws),
    );

    const failed = results.find((r) => r.error);
    if (failed?.error) throw new Error(failed.error.message);

    return { ok: true, updated: ids.length };
  } catch (error) {
    return {
      ok: false,
      updated: 0,
      error: error instanceof Error ? error.message : "The threads could not be updated",
    };
  }
}

/** Marks threads read or unread. The lightest write in the inbox. */
export async function setThreadSeen(threadIds: string[], seen: boolean): Promise<ActionResult> {
  try {
    const ids = validate(threadIds);
    const ws = await workspaceId();
    const sb = getMasterInboxSupabase();

    const results = await chunkedRun(ids, (slice) =>
      sb.from("threads").update({ seen }).in("id", slice).eq("workspace_id", ws),
    );

    const failed = results.find((r) => r.error);
    if (failed?.error) throw new Error(failed.error.message);

    return { ok: true, updated: ids.length };
  } catch (error) {
    return {
      ok: false,
      updated: 0,
      error: error instanceof Error ? error.message : "The threads could not be updated",
    };
  }
}
