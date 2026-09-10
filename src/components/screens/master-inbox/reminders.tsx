/*
 * Reminders — the tool's own page.
 *
 * Replaces a hand-written screen that listed reminders and could not dismiss
 * one: `DismissReminderButton` was never mounted, so the only action the page
 * has did not exist. Found by scripts/inbox-inventory.mjs (0 of 3 components).
 *
 * The tabs are the design's (see mockup/tabs.tsx); everything else — the
 * loaders, the grouping, the dismiss action — is the tool's.
 */

import Link from "next/link";
import { Clock, Mail, ArrowRight } from "lucide-react";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { TopBar } from "@/components/master-inbox/top-bar";
import { MockupTabs } from "./mockup/tabs";
import { loadViewCounts } from "@/lib/tools/master-inbox/inbox/views";
import { loadViews } from "@/lib/tools/master-inbox/inbox/views";
import { loadLabels } from "@/lib/tools/master-inbox/inbox/labels";
import { DismissReminderButton } from "@/components/master-inbox/dismiss-reminder-button";


interface ReminderRow {
  id: string;
  thread_id: string;
  remind_at: string;
  note: string | null;
  status: "pending" | "fired" | "dismissed";
  threads:
    | { id: string; subject: string | null; leads: { full_name: string | null; email: string | null } | null }
    | null;
}

export async function RemindersScreen() {
  const session = await requireSession();
  const admin = createAdminSupabase();
  const wsId = session.activeWorkspace.id;
  const now = new Date().toISOString();

  // Auto-fire any reminders whose time has come — flip the thread back to
  // open and mark the reminder as fired. Visiting the page is effectively
  // the alarm clock: due threads return to your inbox.
  const { data: dueReminders } = await admin
    .from("reminders")
    .select("id, thread_id")
    .eq("workspace_id", wsId)
    .eq("status", "pending")
    .lte("remind_at", now);
  if (dueReminders && dueReminders.length > 0) {
    const reminderIds = dueReminders.map((r) => r.id as string);
    const threadIds = dueReminders.map((r) => r.thread_id as string);
    await admin.from("reminders").update({ status: "fired" }).in("id", reminderIds);
    await admin
      .from("threads")
      .update({ status: "open" })
      .in("id", threadIds)
      .eq("workspace_id", wsId);
  }

  const { data: rows } = await admin
    .from("reminders")
    .select(
      "id, thread_id, remind_at, note, status, threads:thread_id(id, subject, leads:lead_id(full_name, email))",
    )
    .eq("workspace_id", wsId)
    .eq("status", "pending")
    .order("remind_at", { ascending: true });

  const [views, labels, viewCounts] = await Promise.all([
    loadViews(wsId),
    loadLabels(wsId),
    loadViewCounts(wsId, null),
  ]);
  const reminders = (rows ?? []) as unknown as ReminderRow[];

  return (
    <div className="mi-theme">
      <TopBar />
      <MockupTabs
        views={views.map((v) => ({ id: v.id, slug: v.slug, name: v.name }))}
        activeSlug=""
        counts={viewCounts}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-8">
          <div className="mb-6">
            <h1 className="text-xl font-semibold tracking-tight">Reminders</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Threads you&apos;ve snoozed. They auto-return to your inbox at the scheduled
              time the next time you open this page.
            </p>
          </div>

          {reminders.length === 0 ? (
            <div className="rounded-lg border bg-card p-10 text-center">
              <Clock className="size-7 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm font-medium">No snoozed threads</p>
              <p className="text-xs text-muted-foreground mt-1">
                Open any thread and click the clock icon in the toolbar to snooze it.
              </p>
            </div>
          ) : (
            <ul className="rounded-lg border bg-card divide-y">
              {reminders.map((r) => {
                const thread = r.threads;
                const lead = thread?.leads;
                const remindAt = new Date(r.remind_at);
                return (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="size-9 rounded-md bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                      <Mail className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        {lead?.full_name || lead?.email || "Unknown"}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {thread?.subject || "(no subject)"}
                      </p>
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums shrink-0">
                      <Clock className="size-3 inline-block mr-1 -mt-0.5" />
                      {remindAt.toLocaleString()}
                    </div>
                    <DismissReminderButton threadId={r.thread_id} />
                    {thread?.id ? (
                      <Link
                        href={`/inbox/all-email/${thread.id}`}
                        className="size-8 rounded-md flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground"
                        aria-label="Open thread"
                      >
                        <ArrowRight className="size-4" />
                      </Link>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
