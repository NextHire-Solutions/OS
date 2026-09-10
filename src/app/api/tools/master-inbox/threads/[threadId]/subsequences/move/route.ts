import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createInstantlyClient, InstantlyError } from "@/lib/tools/master-inbox/instantly/client";
import { syncThreadSubsequence } from "@/lib/tools/master-inbox/inbox/subsequence-sync";

// POST /api/threads/[threadId]/subsequences/move
// Body: { subsequence_id: string }
//
// Resolves the Instantly lead UUID from the thread's lead email (webhook
// payloads don't carry the UUID, so a /leads/list lookup is required), then
// calls Instantly's /leads/subsequence/move endpoint to add the lead.
//
// On success we cache the resolved Instantly lead UUID on our leads row so
// subsequent moves skip the lookup.

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  subsequence_id: z.string().min(1),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;

  const userClient = await createServerSupabase();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const { subsequence_id } = parsed.data;

  // Confirm the user can see this thread (RLS).
  const { data: visible } = await userClient
    .from("threads")
    .select("id")
    .eq("id", threadId)
    .maybeSingle();
  if (!visible) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const admin = createAdminSupabase();
  const { data: thread } = await admin
    .from("threads")
    .select("id, source_provider, lead_id, subsequence_id")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }
  if (thread.source_provider !== "instantly") {
    return NextResponse.json(
      { error: "Subsequences are only available for Instantly threads." },
      { status: 400 },
    );
  }
  if (!thread.lead_id) {
    return NextResponse.json(
      { error: "Thread has no lead." },
      { status: 400 },
    );
  }
  // A lead can only be in one subsequence at a time — block re-adding.
  // The UI disables the button too; this guards a stale client.
  if (thread.subsequence_id) {
    return NextResponse.json(
      { error: "This lead is already in a subsequence." },
      { status: 409 },
    );
  }

  const { data: lead } = await admin
    .from("leads")
    .select("id, email, instantly_lead_id")
    .eq("id", thread.lead_id)
    .maybeSingle();
  if (!lead?.email) {
    return NextResponse.json(
      { error: "Lead has no email — cannot resolve Instantly lead UUID." },
      { status: 400 },
    );
  }

  let instantly;
  try {
    instantly = createInstantlyClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Instantly not configured" },
      { status: 400 },
    );
  }

  // Resolve the Instantly lead UUID. Prefer the cached id; otherwise look
  // it up via /leads/list and persist for next time.
  let instantlyLeadId = lead.instantly_lead_id as string | null;
  if (!instantlyLeadId) {
    try {
      const found = await instantly.findLeadByEmail(lead.email);
      const match =
        (found.items ?? []).find(
          (l) => l.email?.toLowerCase() === lead.email.toLowerCase(),
        ) ?? found.items?.[0];
      if (!match?.id) {
        return NextResponse.json(
          { error: `No Instantly lead found for ${lead.email}.` },
          { status: 404 },
        );
      }
      instantlyLeadId = match.id;
      await admin
        .from("leads")
        .update({ instantly_lead_id: instantlyLeadId })
        .eq("id", lead.id);
    } catch (err) {
      if (err instanceof InstantlyError) {
        return NextResponse.json(
          { error: err.message, status: err.status, body: err.body },
          { status: 502 },
        );
      }
      throw err;
    }
  }

  try {
    await instantly.moveLeadToSubsequence({
      lead_id: instantlyLeadId,
      subsequence_id,
    });
  } catch (err) {
    if (err instanceof InstantlyError) {
      return NextResponse.json(
        { error: err.message, status: err.status, body: err.body },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "move failed" },
      { status: 502 },
    );
  }

  // Refresh the thread's cached subsequence state so the panel's
  // indicator reflects the move. Background — don't hold up the response.
  void syncThreadSubsequence(threadId).catch(() => {});

  return NextResponse.json({ ok: true, instantly_lead_id: instantlyLeadId });
}
