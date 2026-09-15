import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireSession } from "@/lib/auth/workspace";
import { WORKSPACE_COOKIE } from "@/lib/tools/master-inbox/auth/workspace-cookie";

// Switches the active workspace by setting our cookie. Verifies the caller is
// a member of the target workspace via RLS.
//
// One adaptation from the tool's `app/api/workspaces/switch/route.ts`. The
// tool proved membership by reading `workspace_members` for `user.id` under
// RLS. OS users have no `auth.users` row — `user.id` is null here, for the
// reason set out in src/lib/auth/workspace.ts — so that lookup can never
// match. The memberships the OS can vouch for are `requireSession().workspaces`,
// which is the same question answered by the authority that has the answer.

const schema = z.object({ workspace_id: z.string().uuid() });

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "workspace_id required" }, { status: 400 });
  }

  const session = await requireSession();
  const membership = session.workspaces.find((w) => w.id === parsed.data.workspace_id);
  if (!membership) {
    return NextResponse.json({ error: "Not a member of that workspace" }, { status: 403 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(WORKSPACE_COOKIE, parsed.data.workspace_id, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
