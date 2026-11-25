import { NextResponse } from "next/server";
import { z } from "zod";
import { snoozeThread, unsnoozeThread } from "@/lib/tools/master-inbox/inbox/snooze";

// Snoozes (or un-snoozes) a thread. POST body:
//   { remind_at: ISO-8601 string }   -> create reminder + thread.status='reminder'
//   { dismiss: true }                -> drop active reminder + thread.status='open'
// The work itself lives in lib (inbox/snooze.ts) so the Claude connector runs the same code.

export const dynamic = "force-dynamic";

const snoozeSchema = z.object({
  remind_at: z.string().datetime(),
  note: z.string().max(500).optional(),
});

const dismissSchema = z.object({ dismiss: z.literal(true) });

export async function POST(request: Request) {
  const threadId = new URL(request.url).searchParams.get("threadId") ?? "";
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);

  // Dismiss path: cancel any active reminder and put the thread back in inbox.
  if (dismissSchema.safeParse(body).success) {
    const r = await unsnoozeThread(threadId);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, dismissed: true });
  }

  // Snooze path: insert a pending reminder + flip thread status.
  const parsed = snoozeSchema.safeParse(body);
  if (!parsed.success) {
    // (Before 25 Nov an unknown thread was refused 404 even with a bad body; now a bad body is 400 first. Valid requests: unchanged.)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const r = await snoozeThread(threadId, parsed.data.remind_at, parsed.data.note ?? null);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, remind_at: parsed.data.remind_at });
}
