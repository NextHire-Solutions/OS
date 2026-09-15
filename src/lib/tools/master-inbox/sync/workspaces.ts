import { createAdminSupabase } from "@/lib/supabase/admin";
import { createEmailBisonClient } from "@/lib/tools/master-inbox/emailbison/client";
import { RELEVANT_EVENTS } from "@/lib/tools/master-inbox/emailbison/types";
import { getSuperAdminEmails } from "@/lib/auth/super-admin";
import { env } from "@/lib/tools/master-inbox/env";
import {
  OS_PUBLIC_URL,
  WEBHOOK_PATHS,
  pointsAtReceiver,
  receiverUrl,
} from "@/lib/tools/master-inbox/webhooks/public-paths";

// Pulls EmailBison's teams (workspaces) and mirrors them to our `workspaces`
// table. Idempotent. Also ensures every super admin user is a member of every
// synced workspace (with role=owner). For workspaces newly created in this
// run, also registers our inbound webhook with EmailBison so events start
// flowing — existing workspaces are left alone to avoid churn.

export interface WebhookResult {
  team_id: number;
  team_name: string;
  ok: boolean;
  webhook_id?: number;
  skipped_existing?: boolean;
  error?: string;
}

export interface SyncSummary {
  workspaces_created: number;
  workspaces_updated: number;
  members_created: number;
  total_teams: number;
  super_admin_users: number;
  errors: Array<{ team_id?: number; team_name?: string; error: string }>;
  webhooks: WebhookResult[];
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40) || "workspace";
}

async function getSuperAdminUserIds(): Promise<string[]> {
  const emails = getSuperAdminEmails();
  if (emails.length === 0) return [];
  const supabase = createAdminSupabase();
  const ids: string[] = [];

  // Supabase admin.listUsers is paginated; pull all pages until we've seen
  // every super admin email or exhausted pages.
  const wanted = new Set(emails);
  let page = 1;
  while (wanted.size > 0 && page < 50) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    for (const u of data.users ?? []) {
      const e = u.email?.toLowerCase();
      if (e && wanted.has(e)) {
        ids.push(u.id);
        wanted.delete(e);
      }
    }
    if (!data.users || data.users.length < 1000) break;
    page += 1;
  }
  return ids;
}

export async function syncEmailBisonWorkspaces(): Promise<SyncSummary> {
  const supabase = createAdminSupabase();
  const eb = createEmailBisonClient();
  const summary: SyncSummary = {
    workspaces_created: 0,
    workspaces_updated: 0,
    members_created: 0,
    total_teams: 0,
    super_admin_users: 0,
    errors: [],
    webhooks: [],
  };
  const newTeams: Array<{ id: number; name: string }> = [];

  const superAdminIds = await getSuperAdminUserIds();
  summary.super_admin_users = superAdminIds.length;
  if (superAdminIds.length === 0) {
    summary.errors.push({
      error: "No super-admin user found. Set SUPER_ADMIN_EMAILS and have that user sign in once before running sync.",
    });
    return summary;
  }
  // The first super admin is the "owner" on workspace rows (NOT NULL FK).
  const ownerUserId = superAdminIds[0];

  let teams: Array<{ id: number; name: string }> = [];
  try {
    const res = await eb.listWorkspaces();
    teams = (res.data ?? []).map((t) => ({ id: t.id, name: t.name }));
  } catch (err) {
    summary.errors.push({
      error: `Failed to list EmailBison teams: ${err instanceof Error ? err.message : String(err)}`,
    });
    return summary;
  }
  summary.total_teams = teams.length;

  for (const team of teams) {
    try {
      // Upsert workspace by emailbison_team_id
      const { data: existing } = await supabase
        .from("workspaces")
        .select("id")
        .eq("emailbison_team_id", team.id)
        .maybeSingle();

      let workspaceId: string;
      if (existing) {
        await supabase
          .from("workspaces")
          .update({ name: team.name })
          .eq("id", existing.id);
        workspaceId = existing.id;
        summary.workspaces_updated += 1;
      } else {
        // Pick a unique slug (`team-name`, `team-name-XX`, …)
        const base = slugify(team.name);
        let slug = base;
        for (let i = 0; i < 5; i++) {
          const { data: slugConflict } = await supabase
            .from("workspaces")
            .select("id")
            .eq("slug", slug)
            .maybeSingle();
          if (!slugConflict) break;
          slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
        }
        const { data: inserted, error: insErr } = await supabase
          .from("workspaces")
          .insert({
            name: team.name,
            slug,
            owner_user_id: ownerUserId,
            emailbison_team_id: team.id,
          })
          .select("id")
          .single();
        if (insErr || !inserted) {
          summary.errors.push({
            team_id: team.id,
            team_name: team.name,
            error: insErr?.message ?? "insert returned no row",
          });
          continue;
        }
        workspaceId = inserted.id;
        summary.workspaces_created += 1;
        newTeams.push({ id: team.id, name: team.name });
        // The bootstrap_workspace trigger seeds labels, custom_views, members
        // for the owner. But we re-assert membership below for ALL super admins.
      }

      // Ensure every super admin has an active membership on this workspace.
      for (const userId of superAdminIds) {
        const { data: m } = await supabase
          .from("workspace_members")
          .select("id, status, role")
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .maybeSingle();
        if (m) {
          if (m.status !== "active" || m.role !== "owner") {
            await supabase
              .from("workspace_members")
              .update({ status: "active", role: "owner" })
              .eq("id", m.id);
          }
        } else {
          await supabase.from("workspace_members").insert({
            workspace_id: workspaceId,
            user_id: userId,
            role: "owner",
            status: "active",
          });
          summary.members_created += 1;
        }
      }
    } catch (err) {
      summary.errors.push({
        team_id: team.id,
        team_name: team.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Register the inbound webhook only for workspaces that were newly created
  // in this run. Existing workspaces are intentionally left untouched so we
  // don't churn their webhook IDs. The per-team listWebhooks check still
  // skips if a webhook with our URL already exists (true idempotency).
  if (newTeams.length > 0) {
    // The EmailBison receiver now runs in the OS (webhooks/emailbison), so a
    // new team is pointed there. The receiver refuses deliveries without
    // its secret, so a team cannot be registered until the secret exists —
    // that is reported per team rather than thrown, like every other
    // per-team failure here.
    const secret = env.EMAILBISON_WEBHOOK_SECRET;
    for (const team of newTeams) {
      if (!secret) {
        summary.webhooks.push({
          team_id: team.id,
          team_name: team.name,
          ok: false,
          error: "MASTER_INBOX_EMAILBISON_WEBHOOK_SECRET is not set; the receiver would reject every delivery",
        });
        continue;
      }
      const targetUrl = receiverUrl(OS_PUBLIC_URL, WEBHOOK_PATHS.emailbison, secret);
      try {
        await eb.switchWorkspace(team.id);
        const existing = await eb.listWebhooks();
        // Matched on the path so a secret rotation still counts as "ours".
        const match = (existing.data ?? []).find((h) =>
          pointsAtReceiver(h.url, OS_PUBLIC_URL, WEBHOOK_PATHS.emailbison),
        );
        if (match) {
          summary.webhooks.push({
            team_id: team.id,
            team_name: team.name,
            ok: true,
            webhook_id: match.id,
            skipped_existing: true,
          });
          continue;
        }
        const created = await eb.createWebhook({
          name: "BrokerStaffer Master Inbox",
          url: targetUrl,
          events: RELEVANT_EVENTS,
        });
        summary.webhooks.push({
          team_id: team.id,
          team_name: team.name,
          ok: true,
          webhook_id: created.data?.id,
        });
      } catch (err) {
        summary.webhooks.push({
          team_id: team.id,
          team_name: team.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return summary;
}
