import { NextResponse, after } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";
import { enforceBlocklist } from "@/lib/tools/master-inbox/portals/enforce-blocklist";
import { notifyPortalAgentChange } from "@/lib/tools/master-inbox/webhooks/slack-portal";

// POST /api/portal/[token]/agents — add an own-team agent. Pushes the
// email to Instantly + EmailBison blocklists when supplied.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  license: z.string().trim().max(80).nullable().optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const { name, email, phone, license } = parsed.data;

  let pushedInstantly = false;
  let pushedEmailBison = false;
  let pushError: string | null = null;
  if (email) {
    const r = await enforceBlocklist(email);
    pushedInstantly = r.pushedInstantly;
    pushedEmailBison = r.pushedEmailBison;
    pushError = r.error;
  }

  const admin = createAdminSupabase();
  const { data, error } = await admin
    .from("client_agents")
    .insert({
      client_id: client.id,
      name,
      email: email ?? null,
      phone: phone ?? null,
      license: license ?? null,
      pushed_to_instantly: pushedInstantly,
      pushed_to_emailbison: pushedEmailBison,
      push_error: pushError,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Slack: announce the new Your Agents entry. after() so a Slack
  // hiccup can't break the user-visible Add action.
  const clientId = client.id;
  after(() =>
    notifyPortalAgentChange({
      clientId,
      name,
      email: email ?? null,
      op: "added",
    }),
  );

  return NextResponse.json({
    ok: true,
    id: data.id,
    pushedInstantly,
    pushedEmailBison,
    pushError,
  });
}
