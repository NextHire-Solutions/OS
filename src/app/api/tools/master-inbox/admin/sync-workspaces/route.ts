import { NextResponse } from "next/server";
import { env } from "@/lib/tools/master-inbox/env";
import { createServerSupabase } from "@/lib/supabase/server";
import { syncEmailBisonWorkspaces } from "@/lib/tools/master-inbox/sync/workspaces";
import { isSuperAdmin } from "@/lib/auth/super-admin";

// Imports EmailBison teams into our `workspaces` table and ensures every super
// admin is a member of every workspace. Called:
//   - on demand by a super admin via this endpoint
//   - automatically when a super admin signs in for the first time
//
// Auth: either a signed-in super admin OR the service-role key as ?token=...

export const dynamic = "force-dynamic";
// Sync can hit a lot of EmailBison teams; allow up to 60s on Railway.
export const maxDuration = 60;

export async function POST(request: Request) {
  const url = new URL(request.url);
  const supplied = url.searchParams.get("token") ?? request.headers.get("x-admin-token");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  let authorized = false;
  if (supplied && serviceKey && supplied === serviceKey) {
    authorized = true;
  } else {
    const supabase = await createServerSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user && isSuperAdmin(user.email)) authorized = true;
  }
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const summary = await syncEmailBisonWorkspaces();
  return NextResponse.json({ ok: true, summary }, { status: 200 });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    note: "POST here as a super admin (or with ?token=<service-role>) to mirror EmailBison teams into our workspaces table.",
  });
}
