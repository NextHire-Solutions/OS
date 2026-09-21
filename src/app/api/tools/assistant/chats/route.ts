import { NextResponse, type NextRequest } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { canUseAssistant, assistantForbiddenMessage } from "@/lib/tools/assistant/access";
import { createChat, listChats } from "@/lib/tools/assistant/store";

export const dynamic = "force-dynamic";

async function session(request: NextRequest) {
  return verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
}

/** The sidebar: this person's chats, newest first. */
export async function GET(request: NextRequest) {
  const me = await session(request);
  if (!me?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canUseAssistant(me)) {
    return NextResponse.json({ error: "Forbidden", detail: assistantForbiddenMessage() }, { status: 403 });
  }
  return NextResponse.json({ chats: await listChats(me.email) });
}

/** New chat. Empty until the first question — nothing is asked here. */
export async function POST(request: NextRequest) {
  const me = await session(request);
  if (!me?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canUseAssistant(me)) {
    return NextResponse.json({ error: "Forbidden", detail: assistantForbiddenMessage() }, { status: 403 });
  }
  return NextResponse.json({ chat: await createChat(me.email) }, { status: 201 });
}
