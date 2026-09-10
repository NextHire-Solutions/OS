/*
 * Settings › members — the tool's own page, running here.
 *
 * A near-verbatim port of `app/(app)/settings/members/page.tsx`. The only edits
 * are the import paths and the export name; the loaders, the copy and the
 * editor component are the tool's.
 *
 * These are the EDITORS. The OS previously showed this data read-only, which
 * meant anyone who needed to change a label, a template or an agent had to go
 * back to the old app — the thing this workspace exists to replace.
 */

import { requireSession } from "@/lib/auth/workspace";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSuperAdmin } from "@/lib/auth/super-admin";
import { SettingsPageShell } from "@/components/master-inbox/settings/page-shell";
import { MembersClient } from "@/components/master-inbox/settings/members-client";


export async function SettingsMembers() {
  const session = await requireSession();
  const superAdmin = isSuperAdmin(session.user.email);

  if (!superAdmin) {
    return (
      <SettingsPageShell
        title="Members"
        description="Only the workspace admin can manage members."
      >
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          Ask <a className="underline" href="mailto:admin@outreachify.io">admin@outreachify.io</a>
          {" "}to invite teammates to this workspace.
        </div>
      </SettingsPageShell>
    );
  }

  // Super admin: list all workspaces and all members, with invite controls.
  const admin = createAdminSupabase();
  const [{ data: workspaces }, { data: members }] = await Promise.all([
    admin.from("workspaces").select("id, name, emailbison_team_id").order("name"),
    admin
      .from("workspace_members")
      .select("id, role, status, user_id, workspace_id, created_at")
      .order("created_at", { ascending: false }),
  ]);

  // Resolve user emails — workspace_members.user_id maps to auth.users; pull
  // through the admin API.
  const userIds = Array.from(new Set((members ?? []).map((m) => m.user_id).filter(Boolean))) as string[];
  const userEmailById = new Map<string, string>();
  if (userIds.length > 0) {
    // Pull pages until we've covered all user IDs.
    let page = 1;
    const remaining = new Set(userIds);
    while (remaining.size > 0 && page < 50) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error || !data.users) break;
      for (const u of data.users) {
        if (remaining.has(u.id) && u.email) {
          userEmailById.set(u.id, u.email);
          remaining.delete(u.id);
        }
      }
      if (data.users.length < 1000) break;
      page += 1;
    }
  }

  const memberRows =
    (members ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      status: m.status,
      workspace_id: m.workspace_id,
      user_id: m.user_id,
      email: m.user_id ? userEmailById.get(m.user_id) ?? "(unknown)" : "(unlinked)",
      created_at: m.created_at,
    }));

  return (
    <SettingsPageShell
      title="Members"
      description="Invite teammates and assign them to workspaces."
    >
      <MembersClient
        workspaces={workspaces ?? []}
        members={memberRows}
      />
    </SettingsPageShell>
  );
}
