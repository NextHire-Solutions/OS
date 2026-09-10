import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { loadAgents, saveAgent } from "@/lib/tools/master-inbox/ai/agent";

export const dynamic = "force-dynamic";

const PROVIDERS = ["openai", "anthropic", "openrouter", "vllm"] as const;
const MODES = ["human_in_loop", "auto"] as const;
const LENGTHS = ["short", "medium", "long", "variable"] as const;
const CHANNEL_FILTERS = ["email", "both"] as const;

const createSchema = z.object({
  name: z.string().min(1).max(80),
  mode: z.enum(MODES).default("human_in_loop"),
  tone: z.string().min(1).max(80).default("professional"),
  response_length: z.enum(LENGTHS).default("medium"),
  max_tokens: z.number().int().min(64).max(200000).default(30000),
  temperature: z.number().min(0).max(2).default(0.4),
  provider: z.enum(PROVIDERS).default("openai"),
  model: z.string().min(1).max(120).default("gpt-4o-mini"),
  api_key: z.string().min(1).optional(),
  system_prompt: z.string().nullable().optional(),
  channel_ids: z.array(z.string().uuid()).default([]),
  channel_filter: z.enum(CHANNEL_FILTERS).default("both"),
  active: z.boolean().default(true),
  auto_respond_new: z.boolean().default(false),
});

export async function GET() {
  const session = await requireSession();
  const agents = await loadAgents(session.activeWorkspace.id);
  return NextResponse.json({ agents });
}

export async function POST(request: Request) {
  const session = await requireSession();
  const body = await request.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  try {
    const id = await saveAgent({
      workspaceId: session.activeWorkspace.id,
      name: parsed.data.name,
      mode: parsed.data.mode,
      tone: parsed.data.tone,
      response_length: parsed.data.response_length,
      max_tokens: parsed.data.max_tokens,
      temperature: parsed.data.temperature,
      provider: parsed.data.provider,
      model: parsed.data.model,
      apiKey: parsed.data.api_key,
      system_prompt: parsed.data.system_prompt,
      channel_ids: parsed.data.channel_ids,
      channel_filter: parsed.data.channel_filter,
      active: parsed.data.active,
      auto_respond_new: parsed.data.auto_respond_new,
    });
    return NextResponse.json({ id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Save failed" },
      { status: 400 },
    );
  }
}
