import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { loadAiConfig, saveAiConfig } from "@/lib/tools/master-inbox/ai/config";

export const dynamic = "force-dynamic";

const PROVIDERS = ["openai", "anthropic", "openrouter", "vllm"] as const;

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(PROVIDERS).optional(),
  api_key: z.string().nullable().optional(), // pass "" or null to clear
  model: z.string().min(1).max(120).optional(),
  label_old_replies: z.boolean().optional(),
  relabel_ongoing: z.boolean().optional(),
  use_custom_prompt: z.boolean().optional(),
  custom_prompt: z.string().nullable().optional(),
  category_set: z.array(z.string()).optional(),
});

export async function GET() {
  const session = await requireSession();
  const cfg = await loadAiConfig(session.activeWorkspace.id);
  return NextResponse.json({ config: cfg });
}

export async function PATCH(request: Request) {
  const session = await requireSession();
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  try {
    await saveAiConfig({
      workspaceId: session.activeWorkspace.id,
      enabled: parsed.data.enabled,
      provider: parsed.data.provider,
      apiKey:
        parsed.data.api_key === undefined
          ? undefined
          : parsed.data.api_key === ""
            ? null
            : parsed.data.api_key,
      model: parsed.data.model,
      label_old_replies: parsed.data.label_old_replies,
      relabel_ongoing: parsed.data.relabel_ongoing,
      use_custom_prompt: parsed.data.use_custom_prompt,
      custom_prompt: parsed.data.custom_prompt,
      category_set: parsed.data.category_set,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Save failed" },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true });
}
