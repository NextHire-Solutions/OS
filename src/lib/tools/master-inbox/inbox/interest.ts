import { getMasterInboxSupabase as createAdminSupabase } from "../supabase";
import { createEmailBisonClient } from "../emailbison/client";

// "Interested" / "Not Interested" — mirrors the label decision back
// to EmailBison so the reply's interested flag round-trips to
// EmailBison's smart lists + sequence rules. Wired to the same
// labels routes that already trigger DNC + introduction notify.
//
// EmailBison endpoints (verified against docs/emailbison-openapi.json):
//   PATCH /api/replies/{reply_id}/mark-as-interested      { skip_webhooks }
//   PATCH /api/replies/{reply_id}/mark-as-not-interested  { skip_webhooks }
//
// No switchWorkspace dance: BrokerStaffer is single-team on
// EmailBison ("BrokerStaffer's Team", id 2) — every
// channels.emailbison_team_id is 2, so the API token is
// effectively pinned to team 2 by every other call site.
// Matches the lib/portals/enforce-blocklist.ts pattern that
// already skips the switch for the same reason.
//
// Returns an InterestResult so the caller (single + bulk label
// routes) can log the outcome per thread. Errors are caught — a
// remote failure must NEVER break the user-visible label apply,
// which has already returned 200 by the time this runs inside
// after().

export interface InterestResult {
  ok: boolean;
  reply_id: number | null;
  platform: "emailbison" | null;
  // marked              → PATCH succeeded
  // no_thread           → threadId didn't resolve
  // no_reply_id         → no inbound message on the thread carries an
  //                       emailbison_reply_id (very old thread predating
  //                       the column, or a manually-created row)
  // unsupported_provider → the thread is Instantly / unknown — skip
  // error               → caught exception (HTTP failure, etc.)
  status:
    | "marked"
    | "no_thread"
    | "no_reply_id"
    | "unsupported_provider"
    | "error";
  error?: string;
}

export async function markEmailBisonReplyInterested(
  threadId: string,
  interested: boolean,
): Promise<InterestResult> {
  let replyId: number | null = null;
  let platform: "emailbison" | null = null;
  try {
    const admin = createAdminSupabase();
    const { data: thread } = await admin
      .from("threads")
      .select("id, source_provider")
      .eq("id", threadId)
      .maybeSingle();
    if (!thread) {
      return { ok: false, reply_id: null, platform: null, status: "no_thread" };
    }
    if (thread.source_provider !== "emailbison") {
      return {
        ok: false,
        reply_id: null,
        platform: null,
        status: "unsupported_provider",
      };
    }
    platform = "emailbison";

    // Resolve the most recent inbound's EmailBison reply id. That's
    // the lead's last reply — the natural object to mark
    // interested / not-interested on EmailBison's side.
    const { data: lastInbound } = await admin
      .from("messages")
      .select("emailbison_reply_id")
      .eq("thread_id", threadId)
      .eq("direction", "inbound")
      .not("emailbison_reply_id", "is", null)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const rawId = lastInbound?.emailbison_reply_id as string | null | undefined;
    const parsed = rawId ? Number(rawId) : NaN;
    if (!rawId || Number.isNaN(parsed)) {
      return { ok: false, reply_id: null, platform, status: "no_reply_id" };
    }
    replyId = parsed;

    const eb = createEmailBisonClient();
    if (interested) {
      await eb.markReplyAsInterested(replyId);
    } else {
      await eb.markReplyAsNotInterested(replyId);
    }
    console.log(
      `[interest] marked eb reply ${replyId} as ${
        interested ? "interested" : "not interested"
      }`,
    );
    return { ok: true, reply_id: replyId, platform, status: "marked" };
  } catch (err) {
    console.error("[interest] markEmailBisonReplyInterested failed", err);
    return {
      ok: false,
      reply_id: replyId,
      platform,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Case-insensitive label-name checks used by the labels routes.
// "Interested" and "Not Interested" are the exact label names
// seeded in the labels table; we tolerate casing variants in case
// anyone renames them later.
export function isInterestedLabel(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === "interested";
}

export function isNotInterestedLabel(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === "not interested";
}
