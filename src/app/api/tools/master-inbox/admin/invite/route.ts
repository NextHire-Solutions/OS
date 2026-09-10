import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSuperAdmin } from "@/lib/auth/super-admin";

// Super admin creates a new user with an initial password and assigns
// workspace memberships. The new user can immediately sign in with the
// password the super admin set; they can change it from /settings/personal.
//
// `workspace_ids: "all"` adds the user to every workspace in the table.

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  full_name: z.string().optional(),
  role: z.enum(["admin", "member"]).default("member"),
  workspace_ids: z.union([z.array(z.string().uuid()).min(1), z.literal("all")]),
});

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isSuperAdmin(user.email)) {
    return NextResponse.json({ ok: false, error: "Super admin only" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const { email, password, full_name, role, workspace_ids: ids } = parsed.data;

  const admin = createAdminSupabase();

  // Find or create the Supabase auth user.
  let invitedUserId: string | null = null;
  let alreadyExisted = false;
  {
    let page = 1;
    while (page < 50) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) break;
      const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (match) {
        invitedUserId = match.id;
        alreadyExisted = true;
        break;
      }
      if (data.users.length < 1000) break;
      page += 1;
    }
  }

  if (invitedUserId) {
    // Update password + name for existing user.
    const { error } = await admin.auth.admin.updateUserById(invitedUserId, {
      password,
      email_confirm: true,
      ...(full_name ? { user_metadata: { full_name } } : {}),
    });
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      ...(full_name ? { user_metadata: { full_name } } : {}),
    });
    if (error || !data.user) {
      return NextResponse.json(
        { ok: false, error: error?.message ?? "createUser returned no user" },
        { status: 500 },
      );
    }
    invitedUserId = data.user.id;
  }

  // Target workspaces.
  let targets: string[];
  if (ids === "all") {
    const { data: all, error } = await admin.from("workspaces").select("id");
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    targets = (all ?? []).map((w) => w.id);
  } else {
    targets = ids;
  }

  let membershipsCreated = 0;
  let membershipsUpdated = 0;
  for (const workspaceId of targets) {
    const { data: existing } = await admin
      .from("workspace_members")
      .select("id, role, status")
      .eq("workspace_id", workspaceId)
      .eq("user_id", invitedUserId)
      .maybeSingle();
    if (existing) {
      if (existing.role !== role || existing.status !== "active") {
        await admin
          .from("workspace_members")
          .update({ role, status: "active" })
          .eq("id", existing.id);
        membershipsUpdated += 1;
      }
    } else {
      await admin.from("workspace_members").insert({
        workspace_id: workspaceId,
        user_id: invitedUserId,
        role,
        status: "active",
      });
      membershipsCreated += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    user_id: invitedUserId,
    already_existed: alreadyExisted,
    workspaces_targeted: targets.length,
    memberships_created: membershipsCreated,
    memberships_updated: membershipsUpdated,
  });
}
