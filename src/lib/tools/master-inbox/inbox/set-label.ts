import { after } from "next/server";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { isHostileLabel, markThreadLeadDoNotContact, stopThreadPerson } from "@/lib/tools/master-inbox/inbox/dnc";
import { isStopContactLabel } from "@/lib/tools/master-inbox/portals/stop-person-plan";
import {
  isInterestedLabel,
  isNotInterestedLabel,
  markEmailBisonReplyInterested,
} from "@/lib/tools/master-inbox/inbox/interest";
import { notifyIntroductionForThreads } from "@/lib/tools/master-inbox/webhooks/n8n-introduction";
import { pushIntroPipelineEntriesForThreadsToFub } from "@/lib/tools/master-inbox/integrations/push-pipeline-entry";
import { notifyPortalIntroductionForThreads } from "@/lib/tools/master-inbox/webhooks/slack-portal";
import {
  snapshotPipelineNotes,
  restorePipelineNotes,
  type PipelineNotesSnapshot,
} from "@/lib/tools/master-inbox/inbox/preserve-pipeline-notes";

/*
 * Put one label on one inbox thread — the inbox's label click (threads/labels POST), moved here unchanged on 25 Nov so
 * the Claude connector's inbox_set_label runs exactly the same code: the single-label wipe, Introduction notes kept,
 * Hostile → Do Not Contact, stop labels → stop the person everywhere, Introduction → n8n / Follow Up Boss / Slack, and
 * Interested ⇄ EmailBison's interested flag. The route only parses the request and answers.
 */
export type SetLabelResult = { ok: true } | { ok: false; status: number; error: string };

export async function setThreadLabel(threadId: string, labelId: string): Promise<SetLabelResult> {
  const supabase = getMasterInboxSupabase();

  // Snapshot the prior label name BEFORE we wipe it. Needed to detect
  // "transitioning AWAY from Interested" so we can clear the
  // corresponding interested flag on EmailBison's side — otherwise a
  // thread that was Interested and is now Hostile / Keep Warm /
  // anything else would stay interested=true on EmailBison and inflate
  // the Health Dashboard interest count.
  let priorLabelName: string | null = null;
  const { data: priorAssignments } = await supabase
    .from("label_assignments")
    .select("labels:label_id (name)")
    .eq("target_type", "thread")
    .eq("target_id", threadId)
    .neq("label_id", labelId);
  if (priorAssignments && priorAssignments.length > 0) {
    // Single-label semantics → at most one row, but tolerate the
    // pre-May-2026 case where multiple labels existed (we just look
    // for any prior Interested).
    for (const row of priorAssignments) {
      const lbl = Array.isArray(row.labels) ? row.labels[0] : row.labels;
      const name = (lbl as { name?: string | null } | null)?.name ?? null;
      if (isInterestedLabel(name)) {
        priorLabelName = name;
        break;
      }
    }
  }

  // Resolve the label name up front — needed both for the Hostile /
  // Introduction side-effects below AND to preserve pipeline notes across
  // the relabel. When this is an Introduction (re-)tag, snapshot the
  // thread's pipeline notes BEFORE the wipe: the zero-label window lets the
  // 0033 trigger cascade-delete the entry (and its notes), and the
  // re-inserted Introduction label then rebuilds a fresh, note-less entry.
  // We copy the notes back onto the rebuilt entry after the upsert.
  const { data: label } = await supabase
    .from("labels")
    .select("name")
    .eq("id", labelId)
    .maybeSingle();
  const isIntroLabel =
    (label?.name as string | null)?.trim().toLowerCase() === "introduction";
  let notesSnapshot: PipelineNotesSnapshot | null = null;
  if (isIntroLabel) {
    notesSnapshot = await snapshotPipelineNotes(getMasterInboxSupabase(), [
      threadId,
    ]);
  }

  // Single-label-per-thread semantics (May 2026 client decision):
  // applying any label wipes every existing label on the thread first,
  // including AI-assigned guesses. The chip in the inbox row always
  // reflects the latest classification. Done as a delete-then-upsert
  // pair — Supabase REST has no transaction primitive, so we accept a
  // brief window where the thread has zero labels; failure of the
  // upsert below leaves the thread unlabeled rather than double-tagged.
  const deleteOthers = await supabase
    .from("label_assignments")
    .delete()
    .eq("target_type", "thread")
    .eq("target_id", threadId)
    .neq("label_id", labelId);
  if (deleteOthers.error) {
    return { ok: false, status: 400, error: deleteOthers.error.message };
  }

  const { error } = await supabase.from("label_assignments").upsert(
    {
      workspace_id: process.env.MASTER_INBOX_WORKSPACE_ID ?? "",
      label_id: labelId,
      target_type: "thread",
      target_id: threadId,
      assigned_by: "user",
      assigned_user_id: null,
    },
    { onConflict: "label_id,target_type,target_id" },
  );
  if (error) {
    return { ok: false, status: 400, error: error.message };
  }

  // Hostile → auto Do-Not-Contact. Uses the label name resolved above; if
  // it's "Hostile", blacklist the lead on the source platform.
  if (isHostileLabel(label?.name as string | null)) {
    await markThreadLeadDoNotContact(threadId);
  }
  // Hostile, Unsubscribe, Do Not Contact, Add to Blocklist → stop the person
  // everywhere (both platforms, every conversation). Not awaited: it never
  // throws and must not slow the label click.
  if (isStopContactLabel(label?.name as string | null)) {
    void stopThreadPerson(threadId);
  }

  // Introduction → notify n8n + Bison orchestrator + auto-push to
  // Follow Up Boss (if the receiving client has FUB connected). The
  // 0023 DB trigger has already created the pipeline row inside the
  // upsert above; both helpers resolve it post-response.
  //
  // The FUB push is idempotent (skips entries with fub_pushed_at
  // already set) and non-fatal (any error lands on fub_last_error,
  // never bubbles back to the labeling request).
  if (isIntroLabel) {
    after(() => notifyIntroductionForThreads([threadId], "inbox_label"));
    after(() => pushIntroPipelineEntriesForThreadsToFub([threadId]));
    after(() => notifyPortalIntroductionForThreads([threadId]));
    // Copy the pre-relabel notes onto the rebuilt pipeline entry (no-op if
    // the entry survived or already carries notes).
    if (notesSnapshot) {
      const snap = notesSnapshot;
      after(() => restorePipelineNotes(getMasterInboxSupabase(), snap));
    }
  }

  // Interested / Not Interested → round-trip the decision back to
  // EmailBison so the reply's interested flag matches what the
  // operator just set. EmailBison-only; the helper bails for
  // Instantly threads.
  //
  // Three transition cases handled together:
  //   • new = Interested      → set EB interested=true
  //   • new = Not Interested  → set EB interested=false
  //   • new = anything else BUT old was Interested → set EB
  //     interested=false (clears the flag so the lead doesn't keep
  //     showing as Interested on EmailBison's smart lists / our
  //     Health Dashboard after the operator moved them elsewhere).
  const newLabelName = (label?.name as string | null) ?? null;
  const priorWasInterested = isInterestedLabel(priorLabelName);
  if (isInterestedLabel(newLabelName)) {
    after(() => markEmailBisonReplyInterested(threadId, true));
  } else if (isNotInterestedLabel(newLabelName) || priorWasInterested) {
    after(() => markEmailBisonReplyInterested(threadId, false));
  }

  return { ok: true };
}
