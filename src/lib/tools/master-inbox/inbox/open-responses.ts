import type { getMasterInboxSupabase as createServerSupabase } from "../supabase";
import { fetchAllRows } from "../db/paginated-select";

// "Open Responses" — a work-queue view scoped to threads where the
// ball is in OUR court right now:
//
//   • Tagged "Interested"
//   • NOT tagged "Meetings Booked"
//   • The most recent message on the thread is INBOUND (the lead
//     replied, we haven't responded yet)
//
// Drops the moment we reply; returns if the lead replies again. The
// earlier "untagged → also belongs here" branch was removed — those
// threads belong in All Email and surface via the usual unseen
// signals, not the work queue.
//
// Stored on a custom_views row as { preset: "open_responses" }; the
// membership logic lives here so loadThreads and loadViewCounts agree.

export const OPEN_RESPONSES_PRESET = "open_responses";

type ServerSupabase = Awaited<ReturnType<typeof createServerSupabase>>;

// Pure membership test — given a thread's label state and the
// direction of its most recent message, is it an Open Response?
export function isOpenResponse(args: {
  hasInterested: boolean;
  hasMeetingsBooked: boolean;
  lastMessageDirection: "inbound" | "outbound" | null;
}): boolean {
  if (!args.hasInterested) return false;
  if (args.hasMeetingsBooked) return false;
  return args.lastMessageDirection === "inbound";
}

// Resolve the two label ids this view keys on, by name (workspace-scoped).
// Either may be null if the workspace hasn't got that label.
export async function resolveOpenResponseLabelIds(
  supabase: ServerSupabase,
  workspaceId: string,
): Promise<{ interested: string | null; meetingsBooked: string | null }> {
  const { data } = await supabase
    .from("labels")
    .select("id, name")
    .eq("workspace_id", workspaceId)
    .in("name", ["Interested", "Meetings Booked"]);
  let interested: string | null = null;
  let meetingsBooked: string | null = null;
  for (const row of data ?? []) {
    const r = row as { id: string; name: string };
    if (r.name === "Interested") interested = r.id;
    else if (r.name === "Meetings Booked") meetingsBooked = r.id;
  }
  return { interested, meetingsBooked };
}

// Every open thread id in the workspace that qualifies as an Open
// Response. Used by loadThreads to restrict the query via .in("id", …).
export async function openResponsesThreadIds(
  supabase: ServerSupabase,
  workspaceId: string,
): Promise<Set<string>> {
  const { interested, meetingsBooked } = await resolveOpenResponseLabelIds(
    supabase,
    workspaceId,
  );
  // If the workspace doesn't have an "Interested" label there can't
  // be any Open Responses by definition; short-circuit before the
  // expensive label + message walks.
  if (!interested) return new Set();

  // Page past db-max-rows=1000 — see lib/db/paginated-select.ts.
  const threads = await fetchAllRows<{
    id: string;
    last_message_at: string | null;
  }>(({ from, to }) =>
    supabase
      .from("threads")
      .select("id, last_message_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "open")
      .range(from, to),
  );
  const ids = threads.map((t) => t.id);
  if (ids.length === 0) return new Set();

  // thread_id → set of its label ids. Chunked IN() to keep each request
  // URL well under Node's ~16KB header cap — a UUID is ~37 chars, so 150
  // per chunk tops out around 5.5KB.
  const labelsByThread = new Map<string, Set<string>>();
  const CHUNK = 150;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    // Paginate — a 150-id chunk can still match >1000 assignments if
    // threads carry many labels each, and db-max-rows would silently
    // truncate.
    const assignments = await fetchAllRows<{ label_id: string; target_id: string }>(
      ({ from, to }) =>
        supabase
          .from("label_assignments")
          .select("label_id, target_id")
          .eq("workspace_id", workspaceId)
          .eq("target_type", "thread")
          .in("target_id", slice)
          .range(from, to),
    );
    for (const row of assignments) {
      const r = row as { label_id: string; target_id: string };
      const set = labelsByThread.get(r.target_id) ?? new Set<string>();
      set.add(r.label_id);
      labelsByThread.set(r.target_id, set);
    }
  }

  // Narrow to candidates BEFORE the per-thread message lookup — we
  // only need the direction of the last message for threads that
  // already pass the label gates. For ~thousands of threads this
  // typically prunes 80%+ of the work.
  const candidates = threads.filter((t) => {
    const labels = labelsByThread.get(t.id);
    return Boolean(
      interested && labels?.has(interested) &&
        !(meetingsBooked && labels?.has(meetingsBooked)),
    );
  });
  if (candidates.length === 0) return new Set();

  // thread_id → direction of the row whose sent_at = last_message_at.
  // Same 150-id chunk pattern. Each chunk fetches only the latest
  // message per thread by pulling all messages newer-or-equal to the
  // thread's last_message_at and keeping the newest per thread.
  // Postgres returns them in `sent_at DESC` order, so the first hit
  // per thread_id is the latest.
  const directionByThread = new Map<string, "inbound" | "outbound">();
  const candidateIds = candidates.map((t) => t.id);
  for (let i = 0; i < candidateIds.length; i += CHUNK) {
    const slice = candidateIds.slice(i, i + CHUNK);
    // Paginate — 150 threads × all their messages can run into the
    // thousands of rows. db-max-rows would silently truncate and we'd
    // end up classifying late threads as having no last-message
    // direction, dropping them from the result.
    const msgs = await fetchAllRows<{
      thread_id: string;
      direction: "inbound" | "outbound";
    }>(({ from, to }) =>
      supabase
        .from("messages")
        .select("thread_id, direction, sent_at")
        .eq("workspace_id", workspaceId)
        .in("thread_id", slice)
        .order("sent_at", { ascending: false })
        .range(from, to),
    );
    for (const row of msgs) {
      const r = row as {
        thread_id: string;
        direction: "inbound" | "outbound";
      };
      if (directionByThread.has(r.thread_id)) continue;
      directionByThread.set(r.thread_id, r.direction);
    }
  }

  const result = new Set<string>();
  for (const t of candidates) {
    const labels = labelsByThread.get(t.id);
    if (
      isOpenResponse({
        hasInterested: Boolean(interested && labels?.has(interested)),
        hasMeetingsBooked: Boolean(meetingsBooked && labels?.has(meetingsBooked)),
        lastMessageDirection: directionByThread.get(t.id) ?? null,
      })
    ) {
      result.add(t.id);
    }
  }
  return result;
}
