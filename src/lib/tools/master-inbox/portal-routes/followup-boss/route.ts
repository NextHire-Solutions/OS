import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";
import { verifyApiKey } from "@/lib/tools/master-inbox/integrations/followup-boss";

// PATCH  /api/portal/[token]/followup-boss   — save (validates first)
// DELETE /api/portal/[token]/followup-boss   — disconnect
//
// Connect flow: client pastes their FUB API key in the Settings card,
// the form hits PATCH here. We call GET /v1/me with the supplied key
// FIRST — on any non-200 we return a clean 400 with FUB's own error
// message and DO NOT persist. Only after FUB confirms the key works
// do we write fub_api_key + fub_connected_at on the client row.
//
// Token-in-path is the credential, same as every other
// /api/portal/<token>/* route.

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  apiKey: z.string().trim().min(8).max(200),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
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
  const apiKey = parsed.data.apiKey;

  const verify = await verifyApiKey(apiKey);
  if (!verify.ok) {
    // Return FUB's own error verbatim so the UI can show
    // "Couldn't connect: <reason>" without a translation layer.
    return NextResponse.json(
      {
        error:
          verify.status === 401
            ? "That API key was rejected by Follow Up Boss. Double-check you copied it from your FUB account settings."
            : `Couldn't reach Follow Up Boss: ${verify.error}`,
      },
      { status: 400 },
    );
  }

  const admin = createAdminSupabase();
  const { error } = await admin
    .from("clients")
    .update({
      fub_api_key: apiKey,
      fub_connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", client.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    account: verify.account,
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const client = await resolvePortalClient(token);
  if (!client) {
    return NextResponse.json({ error: "Portal not found" }, { status: 404 });
  }
  const admin = createAdminSupabase();
  const { error } = await admin
    .from("clients")
    .update({
      fub_api_key: null,
      fub_connected_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", client.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
