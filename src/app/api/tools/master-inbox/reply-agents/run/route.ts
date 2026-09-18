import { NextResponse } from "next/server";
import { z } from "zod";

import { requireSession } from "@/lib/auth/workspace";
import { runReplyAgentForThread } from "@/lib/tools/master-inbox/ai/runtime";

/*
 * POST /api/tools/master-inbox/reply-agents/run — run the agent on one thread.
 *
 *   { "thread_id": "…", "dry_run": true }
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 *
 * Two things, and the second is the reason it exists.
 *
 *   · It is the manual handle on the engine while the inbound webhooks still
 *     use the old "first active agent, draft it" block. Those call sites live
 *     in lib/tools/master-inbox/sync/{emailbison,instantly}.ts and are outside
 *     this change; switching them to `runReplyAgentForThread` is a one-line
 *     edit each, at which point the engine runs on every lead reply.
 *
 *   · `dry_run` makes the whole thing observable without doing anything:
 *     which agent was selected and why, which question is next, what the
 *     safety gate says. That is what makes this feature testable against real
 *     conversations without drafting into an operator's composer or spending a
 *     model call — see scripts/reply-agent-workflow-test.mjs.
 *
 * ---------------------------------------------------------------------------
 * dry_run DEFAULTS TO TRUE
 *
 * Deliberately the unusual choice. A POST to this path with no body is the
 * shape of an accident — a curl someone half-remembered, a retried request —
 * and the safe reading of an accident is "tell me what you would do".
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.object({
  thread_id: z.string().uuid(),
  dry_run: z.boolean().default(true),
});

export async function POST(request: Request) {
  const session = await requireSession();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "thread_id is required" },
      { status: 400 },
    );
  }

  try {
    const outcome = await runReplyAgentForThread(
      session.activeWorkspace.id,
      parsed.data.thread_id,
      { dryRun: parsed.data.dry_run },
    );
    return NextResponse.json({ dry_run: parsed.data.dry_run, outcome });
  } catch (err) {
    console.error("[reply-agents/run] failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Run failed" },
      { status: 500 },
    );
  }
}
