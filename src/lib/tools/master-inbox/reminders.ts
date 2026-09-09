import "server-only";

import { getMasterInboxSupabase, workspaceId } from "./supabase";

/*
 * Master Inbox — reminders.
 *
 * ---------------------------------------------------------------------------
 * THE THING TO KNOW ABOUT THIS SCREEN
 *
 * In the live tool, OPENING the reminders page writes. It finds every pending
 * reminder whose time has come, marks it `fired`, and reopens the threads they
 * point at:
 *
 *     update reminders set status = 'fired' where remind_at <= now()
 *     update threads   set status = 'open'  where id in (…)
 *
 * That is a side effect of a page load, and it is load-bearing — it is how a
 * snoozed thread comes back to the inbox at all.
 *
 * The workspace is read-only for now, so it does NOT fire them. It reads the
 * same rows and marks which are due. Two consequences worth being explicit
 * about rather than discovering later:
 *
 *   a reminder shown as "due" here has NOT been actioned. Opening Master
 *   Inbox's own reminders page is still what returns the thread to the inbox.
 *
 *   the screen says so. A due reminder that silently does nothing is worse
 *   than no screen, because it looks handled.
 *
 * When writes land, firing moves behind the tool's own endpoint like every
 * other write — not reimplemented here, so a thread cannot be reopened by the
 * workspace in a way the tool would not have.
 */

export interface Reminder {
  id: string;
  threadId: string | null;
  remindAt: string | null;
  note: string | null;
  subject: string | null;
  leadName: string | null;
  leadEmail: string | null;
  /** True when its time has passed and the tool has not fired it yet. */
  due: boolean;
}

export interface RemindersData {
  reminders: Reminder[];
  /** How many are past due — the number the screen leads with. */
  dueCount: number;
  /** The server's clock, so "due" is decided once, not twice. */
  now: string;
  error: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
type Row = Record<string, unknown>;
const rows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : []);

export async function getReminders(): Promise<RemindersData> {
  const now = new Date();

  try {
    const ws = await workspaceId();
    const { data, error } = await getMasterInboxSupabase()
      .from("reminders")
      .select(
        "id, thread_id, remind_at, note, status, threads:thread_id(id, subject, leads:lead_id(full_name, email))",
      )
      .eq("workspace_id", ws)
      .eq("status", "pending")
      .order("remind_at", { ascending: true });

    if (error) throw new Error(error.message);

    const reminders: Reminder[] = rows(data).map((r) => {
      const thread = (r.threads ?? null) as Row | null;
      const lead = (thread?.leads ?? null) as Row | null;
      const remindAt = str(r.remind_at);
      return {
        id: String(r.id),
        threadId: str(r.thread_id),
        remindAt,
        note: str(r.note),
        subject: str(thread?.subject),
        leadName: str(lead?.full_name),
        leadEmail: str(lead?.email),
        due: remindAt ? new Date(remindAt).getTime() <= now.getTime() : false,
      };
    });

    return {
      reminders,
      dueCount: reminders.filter((r) => r.due).length,
      now: now.toISOString(),
      error: null,
    };
  } catch (error) {
    return {
      reminders: [],
      dueCount: 0,
      now: now.toISOString(),
      error: error instanceof Error ? error.message : "Reminders could not be read",
    };
  }
}
