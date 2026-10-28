import { NextResponse, after } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";
import { enforceBlocklist } from "@/lib/tools/master-inbox/portals/enforce-blocklist";
import { notifyPortalAgentChange } from "@/lib/tools/master-inbox/webhooks/slack-portal";

// PATCH / DELETE /api/portal/[token]/agents/[id]
//
// PATCH allows partial updates from the portal's Edit dialog. If the
// email changes to a new non-empty address we re-push that address to
// Instantly + EmailBison blocklists. The PREVIOUS email stays on the
// providers (same one-directional rule as DELETE — once an address is
// blocked there, only the provider's own UI can un-block it).
//
// DELETE removes the row from our list; provider blocklist entries
// (if pushed earlier) are left in place.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const patchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().email().nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  license: z.string().trim().max(80).nullable().optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = createAdminSupabase();
  const { data: current, error: readErr } = await admin
    .from("client_agents")
    .select("email")
    .eq("id", id)
    .eq("client_id", client.id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 400 });
  if (!current) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const update: Record<string, unknown> = {
    ...parsed.data,
    updated_at: new Date().toISOString(),
  };

  // Re-push only when the email field is present in the payload AND
  // the new value is a non-empty address different from the current one.
  const newEmail = parsed.data.email;
  const emailChanged =
    Object.prototype.hasOwnProperty.call(parsed.data, "email") &&
    newEmail &&
    newEmail !== current.email;
  if (emailChanged && newEmail) {
    const r = await enforceBlocklist(newEmail);
    update.pushed_to_instantly = r.pushedInstantly;
    update.pushed_to_emailbison = r.pushedEmailBison;
    update.push_error = r.error;
  }

  const { error } = await admin
    .from("client_agents")
    .update(update)
    .eq("id", id)
    .eq("client_id", client.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }
  const admin = createAdminSupabase();
  // Read name + email BEFORE the delete so the Slack message has
  // something to say about who was removed.
  const { data: existing } = await admin
    .from("client_agents")
    .select("name, email")
    .eq("id", id)
    .eq("client_id", client.id)
    .maybeSingle();
  const { error } = await admin
    .from("client_agents")
    .delete()
    .eq("id", id)
    .eq("client_id", client.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (existing) {
    const clientId = client.id;
    after(() =>
      notifyPortalAgentChange({
        clientId,
        name: (existing.name as string | null) ?? null,
        email: (existing.email as string | null) ?? null,
        op: "removed",
      }),
    );
  }
  return NextResponse.json({ ok: true });
}
