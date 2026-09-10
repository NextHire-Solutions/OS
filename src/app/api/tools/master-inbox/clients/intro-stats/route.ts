import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/workspace";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";
import { env } from "@/lib/env";

// GET /api/clients/intro-stats[?label=Introduction]
//
// For each BrokerStaffer client, returns:
//   - count: number of threads in that client that have the given label
//   - last_assigned_at: timestamp of the most recent time the label was
//     attached to one of that client's threads
//
// `label` defaults to "Introduction" — the user can pass any label name.
// Match is case-insensitive on the label's name. The "Unknown" client is
// excluded (it's the fallback bucket, not a real client).
//
// Sort order: most-recently-booked clients first, then clients with zero
// intros are appended at the end alphabetically so the consumer can show
// a single mixed list.

export const dynamic = "force-dynamic";

interface ClientStat {
  client_id: string;
  client_name: string;
  client_slug: string;
  count: number;
  last_assigned_at: string | null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const labelName = (url.searchParams.get("label") ?? "Introduction").trim();

  // Auth: normal flow uses the user session (RLS-scoped to their workspace).
  // For diagnostic / external use we accept ?token=<SUPABASE_SERVICE_ROLE_KEY>
  // and resolve the workspace from a `?workspace=<uuid>` param (defaults to
  // the BrokerStaffer singleton via WORKSPACE_ID).
  const suppliedToken = url.searchParams.get("token") ?? request.headers.get("x-admin-token");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  let workspaceId: string;
  if (suppliedToken && serviceKey && suppliedToken === serviceKey) {
    workspaceId =
      url.searchParams.get("workspace") ?? env.WORKSPACE_ID ?? "";
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspace param required when using service-role token" },
        { status: 400 },
      );
    }
  } else {
    // Probe the session lazily — only if the token bypass didn't match.
    const userClient = await createServerSupabase();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const session = await requireSession();
    workspaceId = session.activeWorkspace.id;
  }

  const admin = createAdminSupabase();

  // Resolve the label id by case-insensitive name match scoped to the
  // workspace — the label table has a unique (workspace_id, name) constraint
  // so this is at most one row.
  const { data: labelRow } = await admin
    .from("labels")
    .select("id")
    .eq("workspace_id", workspaceId)
    .ilike("name", labelName)
    .maybeSingle();
  if (!labelRow?.id) {
    return NextResponse.json(
      { error: `Label "${labelName}" not found in this workspace.` },
      { status: 404 },
    );
  }

  // All clients (minus "Unknown") so the response covers every client even
  // those with 0 intros booked yet — the UI gets a stable shape.
  const { data: clientRows } = await admin
    .from("clients")
    .select("id, name, slug")
    .neq("slug", "unknown")
    .order("name", { ascending: true });

  // Two-step: assignments first, then resolve each target thread's
  // client_id with an `in()` lookup. The embedded `threads!inner(...)`
  // approach silently drops fields on some PostgREST shapes (same bug
  // that was hiding view-count pills) — explicit second query is robust.
  // Page past db-max-rows=1000 — see lib/db/paginated-select.ts.
  const assignmentList = await fetchAllRows<{
    assigned_at: string;
    target_id: string;
  }>(({ from, to }) =>
    admin
      .from("label_assignments")
      .select("assigned_at, target_id")
      .eq("workspace_id", workspaceId)
      .eq("target_type", "thread")
      .eq("label_id", labelRow.id)
      .range(from, to),
  );

  const buckets = new Map<string, { count: number; last: string | null }>();
  if (assignmentList.length > 0) {
    const threadIds = Array.from(new Set(assignmentList.map((a) => a.target_id)));
    const threadClient = new Map<string, string | null>();
    // PostgREST URL length cap → chunk the in() filter. 200 keeps the
    // request URL comfortably under the 16 KB header cap even for wide
    // select clauses (same reason as /api/clients/intros — see the
    // 2026-07-07 fix on that route).
    const CHUNK = 200;
    for (let i = 0; i < threadIds.length; i += CHUNK) {
      const slice = threadIds.slice(i, i + CHUNK);
      const { data: threads } = await admin
        .from("threads")
        .select("id, client_id")
        .in("id", slice);
      for (const t of (threads ?? []) as Array<{ id: string; client_id: string | null }>) {
        threadClient.set(t.id, t.client_id);
      }
    }
    for (const a of assignmentList) {
      const cid = threadClient.get(a.target_id);
      if (!cid) continue;
      const prev = buckets.get(cid) ?? { count: 0, last: null };
      prev.count += 1;
      if (!prev.last || (a.assigned_at && a.assigned_at > prev.last)) {
        prev.last = a.assigned_at;
      }
      buckets.set(cid, prev);
    }
  }

  const stats: ClientStat[] = (clientRows ?? []).map((c) => {
    const b = buckets.get(c.id as string);
    return {
      client_id: c.id as string,
      client_name: c.name as string,
      client_slug: c.slug as string,
      count: b?.count ?? 0,
      last_assigned_at: b?.last ?? null,
    };
  });

  // Sort: clients with intros first (most recent at top), then clients
  // with zero intros alphabetically.
  stats.sort((a, b) => {
    if (a.last_assigned_at && b.last_assigned_at) {
      return b.last_assigned_at.localeCompare(a.last_assigned_at);
    }
    if (a.last_assigned_at) return -1;
    if (b.last_assigned_at) return 1;
    return a.client_name.localeCompare(b.client_name);
  });

  return NextResponse.json({
    ok: true,
    label: labelName,
    label_id: labelRow.id,
    stats,
  });
}
