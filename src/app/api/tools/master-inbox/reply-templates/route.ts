import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";

// GET  /api/reply-templates  → list templates for the workspace
// POST /api/reply-templates  → create a template
//   { name, body, category?, subject?, cc?, bcc?, body_html? }

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  body: z.string().max(20_000).default(""),
  body_html: z.string().max(40_000).nullable().optional(),
  subject: z.string().trim().max(200).nullable().optional(),
  cc: z.string().trim().max(400).nullable().optional(),
  bcc: z.string().trim().max(400).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
});

const TEMPLATE_SELECT =
  "id, name, body, body_html, subject, cc, bcc, category, sort_order";

export async function GET() {
  const session = await requireSession();
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("reply_templates")
    .select(TEMPLATE_SELECT)
    .eq("workspace_id", session.activeWorkspace.id)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ templates: data ?? [] });
}

export async function POST(request: Request) {
  const session = await requireSession();
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const supabase = await createServerSupabase();
  // New templates land at the end of the current ordering.
  const { data: maxRow } = await supabase
    .from("reply_templates")
    .select("sort_order")
    .eq("workspace_id", session.activeWorkspace.id)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = (maxRow?.sort_order ?? -1) + 1;

  const { data, error } = await supabase
    .from("reply_templates")
    .insert({
      workspace_id: session.activeWorkspace.id,
      name: parsed.data.name,
      body: parsed.data.body,
      body_html: parsed.data.body_html ?? null,
      subject: parsed.data.subject ?? null,
      cc: parsed.data.cc ?? null,
      bcc: parsed.data.bcc ?? null,
      category: parsed.data.category || null,
      sort_order: nextOrder,
    })
    .select(TEMPLATE_SELECT)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ template: data });
}
