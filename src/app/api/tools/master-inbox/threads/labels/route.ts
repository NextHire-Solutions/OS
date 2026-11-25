import { NextResponse, after } from "next/server";
import { z } from "zod";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { markEmailBisonReplyInterested, isInterestedLabel } from "@/lib/tools/master-inbox/inbox/interest";
import { setThreadLabel } from "@/lib/tools/master-inbox/inbox/set-label";

export const dynamic = "force-dynamic";

const postSchema = z.object({ label_id: z.string().uuid() });
const deleteSchema = z.object({ label_id: z.string().uuid() });

export async function POST(request: Request) {
  const threadId = new URL(request.url).searchParams.get("threadId") ?? "";
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }
  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  // The whole label change, side effects included, lives in lib (set-label.ts) so the Claude connector runs the same code.
  const result = await setThreadLabel(threadId, parsed.data.label_id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const threadId = new URL(request.url).searchParams.get("threadId") ?? "";
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }
  
  const body = await request.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const supabase = getMasterInboxSupabase();
  const { error } = await supabase
    .from("label_assignments")
    .delete()
    .eq("label_id", parsed.data.label_id)
    .eq("target_type", "thread")
    .eq("target_id", threadId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // If the operator just removed the "Interested" label entirely
  // (vs. replacing it via POST), clear the corresponding EmailBison
  // interested flag so the lead drops off the Health Dashboard.
  const { data: removedLabel } = await supabase
    .from("labels")
    .select("name")
    .eq("id", parsed.data.label_id)
    .maybeSingle();
  if (isInterestedLabel((removedLabel?.name as string | null) ?? null)) {
    after(() => markEmailBisonReplyInterested(threadId, false));
  }

  return NextResponse.json({ ok: true });
}
