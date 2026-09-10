import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

// Self-service password change. Re-verifies the current password by attempting
// a signInWithPassword (cheap) before updating, then calls updateUser to set
// the new one. Returns 200 on success.

export const dynamic = "force-dynamic";

const schema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8, "New password must be at least 8 characters"),
});

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  // Verify current password by attempting sign-in. The user is already signed
  // in, so this just validates the password without rotating tokens.
  const { error: verifyErr } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: parsed.data.current_password,
  });
  if (verifyErr) {
    return NextResponse.json(
      { ok: false, error: "Current password is incorrect" },
      { status: 403 },
    );
  }

  const { error: updErr } = await supabase.auth.updateUser({
    password: parsed.data.new_password,
  });
  if (updErr) {
    return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
