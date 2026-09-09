import { getMasterInboxSupabase as createAdminSupabase } from "../supabase";
import { loadPipelineEntries } from "../portals/portal-data";
import { pushPersonEvent } from "../integrations/followup-boss";
import { buildFubPayload } from "../integrations/build-fub-payload";
import { chunkedRun } from "../db/chunked-in";

// Shared push helper called from the manual "Push to FUB" route and
// from the inline auto-push hook on stage transitions. Wraps:
//   • load the entry (with merged custom_fields)
//   • load the client's FUB API key
//   • short-circuit if key is unset
//   • call FUB
//   • write fub_event_id / fub_pushed_at on success, fub_last_error
//     on failure
//
// Returns a tagged result so the caller knows whether to toast green
// or red. Never throws.

export type PushOutcome =
  | { ok: true; mode: "created" | "updated"; personId: string | null }
  | { ok: false; reason: "no_key" | "no_entry" | "api_error" | "no_contact"; message: string };

export async function pushPipelineEntryToFub(
  clientId: string,
  entryId: string,
): Promise<PushOutcome> {
  const admin = createAdminSupabase();

  const { data: clientRow } = await admin
    .from("clients")
    .select("id, fub_api_key")
    .eq("id", clientId)
    .maybeSingle();
  if (!clientRow) {
    return {
      ok: false,
      reason: "no_entry",
      message: "Client not found",
    };
  }
  const apiKey = (clientRow.fub_api_key as string | null) ?? null;
  if (!apiKey || !apiKey.trim()) {
    return {
      ok: false,
      reason: "no_key",
      message: "Follow Up Boss is not connected for this client",
    };
  }

  const entries = await loadPipelineEntries(clientId);
  const entry = entries.find((e) => e.id === entryId);
  if (!entry) {
    return {
      ok: false,
      reason: "no_entry",
      message: "Lead not found",
    };
  }

  const person = buildFubPayload(entry);
  const hasEmail = Array.isArray(person.emails) && person.emails.length > 0;
  const hasPhone = Array.isArray(person.phones) && person.phones.length > 0;
  if (!hasEmail && !hasPhone) {
    const note = "Lead has no email or phone — nothing to push to Follow Up Boss";
    await admin
      .from("client_pipeline_entries")
      .update({ fub_last_error: note, updated_at: new Date().toISOString() })
      .eq("id", entryId);
    return { ok: false, reason: "no_contact", message: note };
  }

  const result = await pushPersonEvent(apiKey, person, {
    message: `Introduced via BrokerStaffer${
      entry.introduced_at ? ` on ${entry.introduced_at.slice(0, 10)}` : ""
    }`,
    // Per-entry source: historical rows / introduction-label trigger
    // rows all default to "BrokerStaffer" (the migration default),
    // portal-added rows that came through with the pipeline_source_split
    // flag on carry "Client Entry". FUB will display whichever the
    // entry was tagged with at write time.
    source: entry.source,
  });

  if (!result.ok) {
    const note = `${result.status}: ${result.error}`.slice(0, 500);
    await admin
      .from("client_pipeline_entries")
      .update({ fub_last_error: note, updated_at: new Date().toISOString() })
      .eq("id", entryId);
    return { ok: false, reason: "api_error", message: result.error };
  }

  await admin
    .from("client_pipeline_entries")
    .update({
      fub_event_id: result.eventId,
      fub_pushed_at: new Date().toISOString(),
      fub_last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", entryId);

  return {
    ok: true,
    mode: result.status === 201 ? "created" : "updated",
    personId: result.personId,
  };
}

// Called from the MasterInbox label endpoints (single + bulk) after
// a lead is labeled Introduction. Resolves the thread ids to the
// pipeline_entries the DB trigger just created, filters out anything
// already-pushed or client-less, then serially pushes each to FUB.
//
// Every failure mode is swallowed — this must NEVER break labeling.
// Callers wrap in `after()` from next/server so the user's request
// is unaffected by push latency or errors.
//
// Guardrails (all inherited from pushPipelineEntryToFub):
//   * short-circuits when the client has no fub_api_key
//   * writes fub_pushed_at + fub_event_id on success
//   * writes fub_last_error on API failure (visible in the portal)
//   * FUB API is upsert on email — even if this ran twice for the
//     same lead somehow, the same person record gets updated (no
//     duplicates)
// Additional guardrails HERE:
//   * skips entries where fub_pushed_at is already set (belt +
//     suspenders on top of the API's own idempotency, so we don't
//     even spend the round trip)
//   * sequential loop with a 200 ms gap between calls so a bulk
//     label of 20 leads doesn't fire 20 parallel POSTs at a single
//     FUB tenant (their per-account rate limit is ~120/min)
export async function pushIntroPipelineEntriesForThreadsToFub(
  threadIds: string[],
): Promise<void> {
  try {
    if (threadIds.length === 0) return;
    const admin = createAdminSupabase();
    // chunkedRun to stay under the PostgREST URL-length cap even when
    // an operator bulk-labels a very large batch (schema max is 500,
    // realistically < 20 at a time).
    const chunks = await chunkedRun(threadIds, (slice) =>
      admin
        .from("client_pipeline_entries")
        .select("id, client_id")
        .in("thread_id", slice)
        .eq("stage", "introduction")
        .is("fub_pushed_at", null),
    );
    const rows = chunks.flatMap((c) =>
      (c.data ?? []) as Array<{ id: string; client_id: string }>,
    );
    if (rows.length === 0) return;
    for (const row of rows) {
      try {
        await pushPipelineEntryToFub(row.client_id, row.id);
      } catch (err) {
        console.error(
          "[fub] inbox-label auto-push failed for entry",
          row.id,
          err,
        );
      }
      // Pacing gap between successive pushes to different clients'
      // FUB accounts. 200 ms = ~5/sec, well under FUB's ceiling.
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (err) {
    console.error(
      "[fub] pushIntroPipelineEntriesForThreadsToFub failed",
      err,
    );
  }
}
