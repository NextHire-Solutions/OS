import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { canUseAssistant, assistantForbiddenMessage } from "@/lib/tools/assistant/access";
import { deleteChat, getChat, renameChat } from "@/lib/tools/assistant/store";

export const dynamic = "force-dynamic";

async function guard(request: NextRequest) {
  const me = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!me?.email) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!canUseAssistant(me)) {
    return {
      error: NextResponse.json({ error: "Forbidden", detail: assistantForbiddenMessage() }, { status: 403 }),
    };
  }
  return { email: me.email };
}

/** One chat and its turns. 404 when it is not yours — the same answer as missing. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(request);
  if (g.error) return g.error;
  const found = await getChat(g.email, (await ctx.params).id);
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(found);
}

const Rename = z.object({ title: z.string().min(1).max(120) });

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(request);
  if (g.error) return g.error;
  const parsed = Rename.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A title is required" }, { status: 400 });
  const ok = await renameChat(g.email, (await ctx.params).id, parsed.data.title);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard(request);
  if (g.error) return g.error;
  const ok = await deleteChat(g.email, (await ctx.params).id);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
