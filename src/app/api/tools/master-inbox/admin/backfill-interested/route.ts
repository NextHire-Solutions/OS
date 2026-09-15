import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";
import { markEmailBisonReplyInterested } from "@/lib/tools/master-inbox/inbox/interest";

// One-off backfill: mark every thread currently labeled "Interested" in
// MasterInbox as interested on EmailBison. The forward path (manual label
// routes + lib/ai/run.ts) keeps this in sync going forward; this catches
// up the historical AI-labeled interested leads that never round-tripped
// because the AI path used to write the label straight to the DB.
//
// Reuses markEmailBisonReplyInterested(threadId, true) verbatim, which
// self-filters to EmailBison threads that carry an inbound reply id and
// skips everything else (Instantly, no-reply, deleted). Idempotent — safe
// to re-run; already-interested replies are simply re-set.
//
// Read-only on our DB (labels/threads/messages); the only writes are to
// EmailBison's API — it cannot touch MasterInbox or portal data.
//
// Run via (logged in as an admin):
//   fetch('/api/tools/master-inbox/admin/backfill-interested', { method: 'POST' })
//     .then(r => r.json()).then(console.log)

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Bounded concurrency so we don't hammer EmailBison (no client-side rate
// limiter exists). Each thread does ~2 light DB reads + at most 1 EB call.
const CONCURRENCY = 5;

export async function POST() {
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.id;
  const admin = createAdminSupabase();

  // Resolve the "Interested" label id for this workspace.
  const { data: labelRow, error: labelErr } = await admin
    .from("labels")
    .select("id")
    .eq("workspace_id", workspaceId)
    .ilike("name", "Interested")
    .maybeSingle();
  if (labelErr) {
    return NextResponse.json({ error: labelErr.message }, { status: 500 });
  }
  if (!labelRow?.id) {
    return NextResponse.json(
      { error: 'No "Interested" label in this workspace.' },
      { status: 404 },
    );
  }

  // Drain every Interested thread assignment (past the 1000-row cap).
  const assignments = await fetchAllRows<{ target_id: string }>(({ from, to }) =>
    admin
      .from("label_assignments")
      .select("target_id")
      .eq("workspace_id", workspaceId)
      .eq("label_id", labelRow.id)
      .eq("target_type", "thread")
      .range(from, to),
  );
  const threadIds = Array.from(
    new Set(assignments.map((a) => a.target_id).filter(Boolean)),
  );

  // Tally by InterestResult.status.
  const tally = {
    marked: 0,
    skipped_provider: 0, // unsupported_provider (Instantly / unknown)
    skipped_no_reply: 0, // no inbound emailbison_reply_id
    skipped_no_thread: 0, // thread not found
    errors: 0,
  };
  const errorSamples: string[] = [];

  for (let i = 0; i < threadIds.length; i += CONCURRENCY) {
    const batch = threadIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((tid) => markEmailBisonReplyInterested(tid, true)),
    );
    for (const r of results) {
      switch (r.status) {
        case "marked":
          tally.marked++;
          break;
        case "unsupported_provider":
          tally.skipped_provider++;
          break;
        case "no_reply_id":
          tally.skipped_no_reply++;
          break;
        case "no_thread":
          tally.skipped_no_thread++;
          break;
        case "error":
          tally.errors++;
          if (r.error && errorSamples.length < 5) errorSamples.push(r.error);
          break;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    total: threadIds.length,
    ...tally,
    ...(errorSamples.length > 0 ? { error_samples: errorSamples } : {}),
  });
}
