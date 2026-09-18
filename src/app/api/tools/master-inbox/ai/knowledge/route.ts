import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { isAdmin } from "@/lib/identity/admin";
import { workspaceId } from "@/lib/tools/master-inbox/supabase";
import { loadAgents, loadAgentWithKey } from "@/lib/tools/master-inbox/ai/agent";
import {
  distilKnowledge,
  listProposals,
  loadKnowledge,
  saveKnowledge,
} from "@/lib/tools/master-inbox/ai/distil";

/*
 * The agent's instructions in plain English: the house style and the objection
 * playbook.
 *
 * GET    — both documents, when they were distilled, who edited them last, and
 *          any proposals waiting on a person.
 * POST   — distil them from the corpus. Minutes is not a risk here: the two
 *          completions run in parallel over ~160 examples and take seconds, so
 *          unlike the corpus rebuild this needs no job.
 * PATCH  — a person's edit. Recorded as THEIRS, which is what stops the next
 *          distillation overwriting it (see distil.ts).
 *
 * Admin-only, the same gate as the corpus route and for the same two reasons:
 * a distillation spends money at a model provider, and these documents are
 * instructions that every draft in the workspace is written from.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function requireAdmin(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return { error: NextResponse.json({ error: "Not configured." }, { status: 503 }) };
  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!isAdmin(session.email)) {
    return {
      error: NextResponse.json(
        { error: "Forbidden", detail: "Only workspace admins can change what the reply agent is told." },
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
    const ws = await workspaceId();
    const [knowledge, proposals] = await Promise.all([
      loadKnowledge(ws),
      listProposals(ws, "pending"),
    ]);
    return NextResponse.json({ ...knowledge, proposals });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not read the agent's knowledge" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const gate = await requireAdmin(request);
  if ("error" in gate) return gate.error;

  // `force: true` is the deliberate "replace my edits" action. Anything else,
  // including a missing body, means the protective default.
  const body = (await request.json().catch(() => null)) as { force?: unknown; sample?: unknown } | null;
  const force = body?.force === true;
  const sample = typeof body?.sample === "number" && body.sample > 0 ? Math.min(400, body.sample) : undefined;

  try {
    const ws = await workspaceId();

    /*
     * The model and key are the reply agent's own, exactly as the corpus job
     * does it. Distilling with a different model than the one that writes the
     * drafts would be a second thing to configure and a second thing to get
     * wrong; and the encrypted key never leaves the server either way.
     */
    const agents = await loadAgents(ws);
    const candidate = agents.find((a) => a.active && a.has_api_key) ?? agents.find((a) => a.has_api_key);
    if (!candidate) {
      return NextResponse.json(
        { error: "No reply agent has an API key, so there is nothing to distil with." },
        { status: 409 },
      );
    }
    const withKey = await loadAgentWithKey(candidate.id);
    if (!withKey?.api_key) {
      return NextResponse.json(
        { error: `Agent "${candidate.name}" has no usable API key.` },
        { status: 409 },
      );
    }

    const result = await distilKnowledge({
      workspaceId: ws,
      provider: withKey.provider,
      apiKey: withKey.api_key,
      model: withKey.model,
      sample,
      force,
    });

    return NextResponse.json({
      ...result,
      agent: candidate.name,
      model: withKey.model,
      /*
       * Said in words as well as in `applied`/`proposed`, because "nothing
       * changed" and "your edit was protected and a proposal is waiting" look
       * identical on screen otherwise.
       */
      detail:
        result.proposed.length === 0
          ? `Distilled from ${result.readExamples} examples.`
          : `Distilled from ${result.readExamples} examples. ${result.proposed.length === 2 ? "Both documents were" : "One document was"} left as you edited ${result.proposed.length === 2 ? "them" : "it"} — the new version is waiting as a proposal.`,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Distillation failed";
    /*
     * The two failures worth naming. An empty corpus is the expected state
     * before a rebuild; a missing table means migrations/0006 has not been run.
     */
    const status = /corpus is empty/i.test(message) ? 409 : /schema cache/i.test(message) ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(request: Request) {
  const gate = await requireAdmin(request);
  if ("error" in gate) return gate.error;

  const body = (await request.json().catch(() => null)) as
    | { styleGuide?: unknown; objectionPlaybook?: unknown }
    | null;
  if (!body) return NextResponse.json({ error: "Malformed request." }, { status: 400 });

  const patch: { styleGuide?: string; objectionPlaybook?: string } = {};
  if (typeof body.styleGuide === "string") patch.styleGuide = body.styleGuide.slice(0, 20_000);
  if (typeof body.objectionPlaybook === "string") patch.objectionPlaybook = body.objectionPlaybook.slice(0, 20_000);
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
  }

  try {
    const ws = await workspaceId();
    /*
     * Stamped with the editor's address, not a generic "human". That single
     * value is what a later distillation reads to decide whether it may
     * overwrite — and when it decides not to, the screen can say WHOSE edit it
     * is protecting.
     */
    await saveKnowledge(ws, patch, gate.session.email);
    return NextResponse.json({ ok: true, ...(await loadKnowledge(ws)) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not save";
    return NextResponse.json(
      { error: message },
      { status: /schema cache/i.test(message) ? 503 : 500 },
    );
  }
}
