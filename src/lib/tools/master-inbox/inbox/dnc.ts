import { getMasterInboxSupabase as createAdminSupabase } from "../supabase";
import { createEmailBisonClient } from "../emailbison/client";
import { createInstantlyClient } from "../instantly/client";

// "Do Not Contact" — pushes a thread's lead onto the source platform's
// blocklist so the sequencer stops emailing them. Wired to the "Hostile"
// label: whenever that label lands on a thread (AI labeler OR a manual
// add), the lead is auto-blacklisted.
//
// EmailBison  → POST /api/blacklisted-emails  { email }
// Instantly   → POST /block-lists-entries     { bl_value: email }
//
// Returns a DncResult so callers (and the bulk backfill script) can
// report exactly what happened per lead. Errors are caught — a blocklist
// hiccup must never break labeling or a webhook ack.

export interface DncResult {
  ok: boolean;
  email: string | null;
  platform: "emailbison" | "instantly" | null;
  // blocked → pushed to the blocklist; the rest are why it didn't happen.
  status: "blocked" | "no_lead" | "no_email" | "unsupported_provider" | "error";
  error?: string;
}

export async function markThreadLeadDoNotContact(threadId: string): Promise<DncResult> {
  let email: string | null = null;
  let platform: "emailbison" | "instantly" | null = null;
  try {
    const admin = createAdminSupabase();
    const { data: thread } = await admin
      .from("threads")
      .select("id, source_provider, lead_id, channel_id")
      .eq("id", threadId)
      .maybeSingle();
    if (!thread?.lead_id) {
      return { ok: false, email: null, platform: null, status: "no_lead" };
    }

    const { data: lead } = await admin
      .from("leads")
      .select("email")
      .eq("id", thread.lead_id)
      .maybeSingle();
    email = (lead?.email as string | null)?.trim() ?? null;
    if (!email) {
      return { ok: false, email: null, platform: null, status: "no_email" };
    }

    platform = (thread.source_provider as "emailbison" | "instantly" | null) ?? null;

    if (platform === "emailbison") {
      const eb = createEmailBisonClient();
      // The blacklist is team-scoped — switch into the thread's team
      // first so the address is blocked in the right place.
      if (thread.channel_id) {
        const { data: ch } = await admin
          .from("channels")
          .select("emailbison_team_id")
          .eq("id", thread.channel_id)
          .maybeSingle();
        const teamId = ch?.emailbison_team_id as number | null;
        if (teamId) await eb.switchWorkspace(teamId);
      }
      await eb.blacklistEmail(email);
      console.log(`[dnc] blacklisted ${email} on EmailBison`);
      return { ok: true, email, platform, status: "blocked" };
    }

    if (platform === "instantly") {
      const inst = createInstantlyClient();
      await inst.blockEmail(email);
      console.log(`[dnc] blocked ${email} on Instantly`);
      return { ok: true, email, platform, status: "blocked" };
    }

    return { ok: false, email, platform, status: "unsupported_provider" };
  } catch (err) {
    console.error("[dnc] markThreadLeadDoNotContact failed", err);
    return {
      ok: false,
      email,
      platform,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Case-insensitive check used by the label hooks.
export function isHostileLabel(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === "hostile";
}
