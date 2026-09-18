import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { isAdmin } from "@/lib/identity/admin";
import { corpusStatus, startCorpusRebuild } from "@/lib/tools/master-inbox/ai/corpus-job";

/*
 * The reply agent's knowledge corpus: what it holds, and rebuilding it.
 *
 * GET  — counts, when it was last built, and the breakdown by situation.
 * POST — starts a rebuild and returns at once. The work takes minutes; the
 *        screen polls GET rather than holding a request open.
 *
 * Admin-only. A rebuild reads every message in the workspace and spends a few
 * cents on embeddings, which is not something any signed-in user should be
 * able to set off.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function requireAdmin(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return { error: NextResponse.json({ error: "Not configured." }, { status: 503 }) };
  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!isAdmin(session.email)) {
    return {
      error: NextResponse.json(
        { error: "Forbidden", detail: "Only workspace admins can rebuild the reply corpus." },
        { status: 403 },
      ),
    };
  }
  return { session };
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if ("error" in gate) return gate.error;
  try {
    return NextResponse.json(await corpusStatus());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not read the corpus" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request);
  if ("error" in gate) return gate.error;

  const result = await startCorpusRebuild();
  if (!result.started) {
    const detail =
      result.reason === "already-running"
        ? "A rebuild is already running."
        : result.reason === "no-agent-key"
          ? "No reply agent has an API key, so the examples cannot be embedded."
          : result.reason === "no-table"
            ? "The corpus table does not exist yet — run migrations/0006_os_reply_intelligence.sql in the Master Inbox Supabase project, then try again."
            : "No workspace found.";
    return NextResponse.json({ started: false, reason: result.reason, detail }, { status: 409 });
  }
  return NextResponse.json({ started: true });
}
