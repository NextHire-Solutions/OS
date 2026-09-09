import "server-only";

import { after } from "next/server";

import { getMasterInboxSupabase, workspaceId } from "./supabase";
import { isHostileLabel, markThreadLeadDoNotContact } from "./inbox/dnc";
import {
  isInterestedLabel,
  isNotInterestedLabel,
  markEmailBisonReplyInterested,
} from "./inbox/interest";
import { enqueueIntroduction } from "./outbox";
import {
  restorePipelineNotes,
  snapshotPipelineNotes,
  type PipelineNotesSnapshot,
} from "./inbox/preserve-pipeline-notes";

/*
 * Master Inbox — labelling a thread.
 *
 * ---------------------------------------------------------------------------
 * THE MOST CONSEQUENTIAL WRITE IN THE WORKSPACE
 *
 * Applying one label does all of this:
 *
 *   wipes every other label — single-label-per-thread, a May 2026 decision;
 *   fires a database trigger that CREATES A ROW IN THE CLIENT'S LIVE PORTAL;
 *   posts to n8n and to the Bison orchestrator;
 *   pushes the lead to Follow Up Boss, if that client has FUB connected;
 *   posts to Slack;
 *   round-trips the decision to EmailBison so its interested flag matches;
 *   blacklists the lead on the source platform, if the label is Hostile.
 *
 * Which is why this is a port of the tool's handler rather than an
 * implementation of it. Every branch below is theirs, including the ones whose
 * absence would be invisible until a client noticed.
 *
 * ---------------------------------------------------------------------------
 * THE TWO SUBTLETIES THAT ARE EASY TO DROP
 *
 * 1. NOTES ARE SNAPSHOTTED BEFORE THE WIPE.
 *
 *    There is no transaction here — PostgREST has none — so applying a label
 *    is delete-then-upsert, with a brief window where the thread carries zero
 *    labels. During that window the 0033 trigger cascade-deletes the pipeline
 *    entry AND ITS NOTES, and the re-inserted label rebuilds a fresh, empty
 *    one. Without the snapshot, re-tagging a thread as Introduction silently
 *    destroys everything the client wrote in their portal.
 *
 * 2. MOVING *AWAY* FROM INTERESTED MUST CLEAR THE FLAG.
 *
 *    The prior label is read before the wipe for this. A thread that was
 *    Interested and is now Hostile would otherwise stay interested=true on
 *    EmailBison, inflating the interest count on the Health Dashboard —
 *    silently, and in the direction that flatters.
 *
 * `assigned_user_id` stays null, which is what every existing row already has.
 */

export interface LabelResult {
  ok: boolean;
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Applies a label, replacing whatever the thread had. */
export async function applyLabel(threadId: string, labelId: string): Promise<LabelResult> {
  if (!UUID.test(threadId) || !UUID.test(labelId)) {
    return { ok: false, error: "A thread id and a label id are required" };
  }

  try {
    const sb = getMasterInboxSupabase();
    const ws = await workspaceId();

    /*
     * The prior label, read BEFORE anything is wiped.
     *
     * Only "was it Interested" matters. Single-label semantics mean there is
     * at most one row, but threads labelled before May 2026 can carry several,
     * so this looks through all of them.
     */
    let priorLabelName: string | null = null;
    const { data: prior } = await sb
      .from("label_assignments")
      .select("labels:label_id (name)")
      .eq("target_type", "thread")
      .eq("target_id", threadId)
      .neq("label_id", labelId);

    for (const row of Array.isArray(prior) ? prior : []) {
      const raw = (row as { labels?: unknown }).labels;
      const label = Array.isArray(raw) ? raw[0] : raw;
      const name = (label as { name?: string | null } | null)?.name ?? null;
      if (isInterestedLabel(name)) {
        priorLabelName = name;
        break;
      }
    }

    const { data: labelRow } = await sb
      .from("labels")
      .select("name")
      .eq("id", labelId)
      .maybeSingle();
    const newLabelName = ((labelRow as { name?: string } | null)?.name ?? null) as string | null;
    const isIntroLabel = newLabelName?.trim().toLowerCase() === "introduction";

    // See (1) above: without this, re-tagging destroys the client's notes.
    let notesSnapshot: PipelineNotesSnapshot | null = null;
    if (isIntroLabel) {
      notesSnapshot = await snapshotPipelineNotes(sb, [threadId]);
    }

    const wiped = await sb
      .from("label_assignments")
      .delete()
      .eq("target_type", "thread")
      .eq("target_id", threadId)
      .neq("label_id", labelId);
    if (wiped.error) throw new Error(wiped.error.message);

    const { error } = await sb.from("label_assignments").upsert(
      {
        workspace_id: ws,
        label_id: labelId,
        target_type: "thread",
        target_id: threadId,
        assigned_by: "user",
      },
      { onConflict: "label_id,target_type,target_id" },
    );
    // A failure here leaves the thread UNLABELLED rather than double-tagged,
    // which is the tool's own trade and is why the wipe comes first.
    if (error) throw new Error(error.message);

    // Hostile → blacklist the lead on the platform it came from.
    if (isHostileLabel(newLabelName)) {
      await markThreadLeadDoNotContact(threadId);
    }

    /*
     * Introduction → tell everything downstream.
     *
     * The pipeline row already exists: the 0023 trigger created it inside the
     * upsert above. These run after the response because none of them should
     * make the operator wait, and the FUB push is idempotent and records its
     * own errors rather than failing the label.
     */
    if (isIntroLabel) {
      /*
       * Through the outbox rather than straight to `after()`.
       *
       * The tool fires these three fire-and-forget, so a deploy in that split
       * second loses them permanently and silently: the introduction is in the
       * database and in the client's portal, but n8n never ran, nobody saw it
       * in Slack, and the lead never reached the client's CRM.
       *
       * The outbox records the intent before attempting it, so a lost attempt
       * is retried instead of forgotten. It still attempts immediately, so the
       * normal case is exactly as fast as before.
       */
      after(() => enqueueIntroduction(threadId));

      /*
       * Notes restoration stays inline in `after()`, deliberately.
       *
       * It is a repair of THIS request's damage — the delete-then-upsert wiped
       * the pipeline entry and its notes — so deferring it to a sweep would
       * leave the client's portal missing their own notes in the meantime. The
       * snapshot itself was taken synchronously above, which is the part that
       * cannot be allowed to fail.
       */
      if (notesSnapshot) {
        const snap = notesSnapshot;
        after(() => restorePipelineNotes(sb, snap));
      }
    }

    // See (2) above. Three transitions, one branch each.
    if (isInterestedLabel(newLabelName)) {
      after(() => markEmailBisonReplyInterested(threadId, true));
    } else if (isNotInterestedLabel(newLabelName) || isInterestedLabel(priorLabelName)) {
      after(() => markEmailBisonReplyInterested(threadId, false));
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The label could not be applied",
    };
  }
}

/**
 * Removes a label outright, rather than replacing it.
 *
 * Removing "Interested" clears the EmailBison flag for the same reason the
 * replace path does — otherwise the lead keeps counting as interested after
 * somebody decided it was not.
 */
export async function removeLabel(threadId: string, labelId: string): Promise<LabelResult> {
  if (!UUID.test(threadId) || !UUID.test(labelId)) {
    return { ok: false, error: "A thread id and a label id are required" };
  }

  try {
    const sb = getMasterInboxSupabase();

    const { data: labelRow } = await sb
      .from("labels")
      .select("name")
      .eq("id", labelId)
      .maybeSingle();

    const { error } = await sb
      .from("label_assignments")
      .delete()
      .eq("label_id", labelId)
      .eq("target_type", "thread")
      .eq("target_id", threadId);
    if (error) throw new Error(error.message);

    if (isInterestedLabel((labelRow as { name?: string } | null)?.name ?? null)) {
      after(() => markEmailBisonReplyInterested(threadId, false));
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The label could not be removed",
    };
  }
}

export interface Label {
  id: string;
  name: string;
  color: string | null;
  sentiment: string | null;
}

/** Every label in the workspace, for the picker. */
export async function getLabels(): Promise<{ labels: Label[]; error: string | null }> {
  try {
    const ws = await workspaceId();
    const { data, error } = await getMasterInboxSupabase()
      .from("labels")
      .select("id, name, color, sentiment")
      .eq("workspace_id", ws)
      .order("name");
    if (error) throw new Error(error.message);

    return {
      labels: (Array.isArray(data) ? data : []).map((l) => {
        const row = l as Record<string, unknown>;
        return {
          id: String(row.id),
          name: String(row.name ?? ""),
          color: typeof row.color === "string" ? row.color : null,
          sentiment: typeof row.sentiment === "string" ? row.sentiment : null,
        };
      }),
      error: null,
    };
  } catch (error) {
    return {
      labels: [],
      error: error instanceof Error ? error.message : "Labels could not be read",
    };
  }
}
