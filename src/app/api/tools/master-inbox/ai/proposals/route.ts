import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { isAdmin } from "@/lib/identity/admin";
import { workspaceId } from "@/lib/tools/master-inbox/supabase";
import { decideProposal, listProposals } from "@/lib/tools/master-inbox/ai/distil";

/*
 * Rules the agent proposes, for a person to accept.
 *
 * A distillation that finds a hand-edited style guide does not overwrite it —
 * it files what it would have written here instead. This route is the other
 * half of that: GET lists what is waiting, PATCH accepts or rejects one.
 *
 * Accepting is recorded as the ACCEPTING PERSON'S edit rather than the
 * distillation's, because a human chose it. That matters: it keeps the next
 * distillation asking rather than assuming it has been handed the pen back.
 *
 * The agent never edits its own instructions unattended. This route is the only
 * way a proposal becomes live text.
 */

export const dynamic = "force-dynamic";

async function requireAdmin(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return { error: NextResponse.json({ error: "Not configured." }, { status: 503 }) };
  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!isAdmin(session.email)) {
    return {
      error: NextResponse.json(
        { error: "Forbidden", detail: "Only workspace admins can decide the agent's rules." },
        { status: 403 },
      ),
    };
  }
  return { session };
}

export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if ("error" in gate) return gate.error;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const filter =
    status === "accepted" || status === "rejected" || status === "all" ? status : "pending";
  try {
    return NextResponse.json({ proposals: await listProposals(await workspaceId(), filter) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not read proposals" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  const gate = await requireAdmin(request);
  if ("error" in gate) return gate.error;

  const body = (await request.json().catch(() => null)) as { id?: unknown; decision?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const decision = body?.decision === "accepted" || body?.decision === "rejected" ? body.decision : null;
  if (!id || !decision) {
    return NextResponse.json({ error: "id and decision ('accepted' | 'rejected') are required." }, { status: 400 });
  }

  try {
    const ws = await workspaceId();
    const result = await decideProposal(ws, id, decision, gate.session.email);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not decide";
    // "already been decided" and "no longer exists" are both races with another
    // admin, not server faults — 409 so the screen can just refresh.
    const status = /already been decided|no longer exists/i.test(message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
