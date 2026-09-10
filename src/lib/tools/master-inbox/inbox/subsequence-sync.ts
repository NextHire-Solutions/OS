import { createAdminSupabase } from "@/lib/supabase/admin";
import { createInstantlyClient } from "@/lib/tools/master-inbox/instantly/client";

// Resolves and caches a thread's Instantly subsequence membership onto
// the thread row (migration 0021). The prospect panel reads the cached
// columns — fast — and this keeps them fresh.

export interface SubsequenceState {
  inSubsequence: boolean;
  subsequenceId: string | null;
  name: string | null;
  addedAt: string | null;
}

const EMPTY: SubsequenceState = {
  inSubsequence: false,
  subsequenceId: null,
  name: null,
  addedAt: null,
};

// campaign_id → (subsequence_id → name), 10-minute TTL. A campaign's
// subsequence set is small and rarely changes, and many threads share a
// campaign — so a backfill resolves names with ~1 call per campaign
// instead of one per thread.
const subNameCache = new Map<string, { at: number; names: Map<string, string> }>();
const SUB_TTL_MS = 10 * 60 * 1000;

async function resolveSubName(
  client: ReturnType<typeof createInstantlyClient>,
  campaignId: string,
  subId: string,
): Promise<string | null> {
  let entry = subNameCache.get(campaignId);
  if (!entry || Date.now() - entry.at > SUB_TTL_MS) {
    try {
      const subs = await client.listSubsequences(campaignId);
      const names = new Map<string, string>();
      for (const s of subs.items ?? []) names.set(s.id, s.name);
      entry = { at: Date.now(), names };
      subNameCache.set(campaignId, entry);
    } catch {
      return null; // name is optional — the indicator still shows
    }
  }
  return entry.names.get(subId) ?? null;
}

// Look up the thread's lead in Instantly, resolve current subsequence
// membership, persist it on the thread, and return the state. Safe to
// call before migration 0021 — the column write just no-ops then.
export async function syncThreadSubsequence(threadId: string): Promise<SubsequenceState> {
  const admin = createAdminSupabase();
  const { data: thread } = await admin
    .from("threads")
    .select("id, source_provider, campaign_id, lead_id")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread || thread.source_provider !== "instantly" || !thread.lead_id) {
    return EMPTY;
  }

  const { data: lead } = await admin
    .from("leads")
    .select("email")
    .eq("id", thread.lead_id)
    .maybeSingle();
  const email = (lead?.email as string | null)?.trim();
  if (!email) return EMPTY;

  const client = createInstantlyClient();
  const res = await client.findLeadByEmail(email);
  const instLead =
    (res.items ?? []).find(
      (l) => (l.email ?? "").toLowerCase() === email.toLowerCase(),
    ) ?? res.items?.[0];
  const subId = instLead?.subsequence_id ?? null;

  let name: string | null = null;
  if (subId && thread.campaign_id) {
    name = await resolveSubName(client, thread.campaign_id as string, subId);
  }

  const state: SubsequenceState = {
    inSubsequence: Boolean(subId),
    subsequenceId: subId,
    name,
    addedAt: instLead?.timestamp_added_subsequence ?? null,
  };

  // Persist onto the thread. .update() returns an error rather than
  // throwing if the columns don't exist yet — harmless.
  await admin
    .from("threads")
    .update({
      subsequence_id: subId,
      subsequence_name: name,
      subsequence_added_at: state.addedAt,
      subsequence_synced_at: new Date().toISOString(),
    })
    .eq("id", threadId);

  return state;
}
