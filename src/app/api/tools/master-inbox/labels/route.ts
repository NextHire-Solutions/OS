import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLORS = ["green", "red", "amber", "zinc", "stone", "pink", "blue"] as const;
const SENTIMENTS = ["positive", "negative", "neutral"] as const;
const PLATFORMS = ["email", "both"] as const;

const createSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.enum(COLORS).default("zinc"),
  sentiment: z.enum(SENTIMENTS).default("neutral"),
  platform: z.enum(PLATFORMS).default("both"),
  obligation: z.boolean().default(false),
  mirror_to_emailbison: z.boolean().default(false),
});

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

  const supabase = await createServerSupabase();
  // Place new labels at the end of the user's current ordering.
  const { data: maxRow } = await supabase
    .from("labels")
    .select("sort_order")
    .eq("workspace_id", session.activeWorkspace.id)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = (maxRow?.sort_order ?? -1) + 1;

  const { data, error } = await supabase
    .from("labels")
    .insert({
      workspace_id: session.activeWorkspace.id,
      name: parsed.data.name,
      color: parsed.data.color,
      sentiment: parsed.data.sentiment,
      platform: parsed.data.platform,
      obligation: parsed.data.obligation,
      mirror_to_emailbison: parsed.data.mirror_to_emailbison,
      sort_order: nextOrder,
      is_system: false,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ id: data.id });
}
