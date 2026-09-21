import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { env } from "@/lib/tools/master-inbox/env";
import { canUseAssistant, assistantForbiddenMessage } from "@/lib/tools/assistant/access";
import { runTurn } from "@/lib/tools/assistant/engine";
import { loadAssistantKey, openAiModel } from "@/lib/tools/assistant/openai";
import { appendMessage, getChat, titleFromFirstQuestion } from "@/lib/tools/assistant/store";

/*
 * Ask a question.
 *
 * Not streamed, deliberately, and this is the one place that choice shows.
 * A turn is several tool calls against four databases and then a model reply;
 * streaming the final tokens would hide the part that actually takes the time
 * behind a cursor that looks stuck. The screen shows which tools are running
 * instead, which is both more honest and more useful.
 */
export const dynamic = "force-dynamic";
// Four tool rounds across four products, then a model reply. The platform
// default would cut a slow one off mid-answer with nothing written down.
export const maxDuration = 120;

const Ask = z.object({ question: z.string().min(1).max(2000) });

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const me = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!me?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canUseAssistant(me)) {
    return NextResponse.json({ error: "Forbidden", detail: assistantForbiddenMessage() }, { status: 403 });
  }

  const parsed = Ask.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A question is required" }, { status: 400 });
  const question = parsed.data.question.trim();

  const chatId = (await ctx.params).id;
  const existing = await getChat(me.email, chatId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workspaceId = env.WORKSPACE_ID;
  if (!workspaceId) {
    return NextResponse.json({ error: "This server has no workspace configured." }, { status: 503 });
  }

  /*
   * The question is written down BEFORE the model runs. If the turn then fails
   * — a dead product, a refused key — the person still sees what they asked
   * next to the failure, instead of an empty chat and an error toast.
   */
  await appendMessage({ chatId, role: "user", content: question });
  const titled = await titleFromFirstQuestion(chatId, question);

  try {
    const { apiKey, model } = await loadAssistantKey(workspaceId);
    const history = existing.messages.map((m) => ({ role: m.role, content: m.content }));
    const turn = await runTurn(history, question, openAiModel(apiKey, model));

    await appendMessage({
      chatId,
      role: "assistant",
      content: turn.answer,
      toolCalls: turn.toolCalls,
      tokensPrompt: turn.tokensPrompt,
      tokensCompletion: turn.tokensCompletion,
    });

    return NextResponse.json({
      answer: turn.answer,
      toolCalls: turn.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments, ms: c.ms })),
      title: titled,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Stored as a turn, so reopening the chat shows what went wrong rather
    // than a question that appears to have been ignored.
    await appendMessage({ chatId, role: "assistant", content: "", error: detail });
    return NextResponse.json({ error: "The assistant could not answer", detail }, { status: 502 });
  }
}
