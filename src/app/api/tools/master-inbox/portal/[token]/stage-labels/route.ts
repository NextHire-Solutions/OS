import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolvePortalClient } from "@/lib/tools/master-inbox/portals/token";
import { assertNoPortalColumns } from "@/lib/tools/master-inbox/portal-guard";
import {
  STAGE_LABEL_MAX_LEN,
  STAGE_ORDER,
  type PipelineStage,
} from "@/lib/tools/master-inbox/portals/portal-data";

// PATCH /api/portal/[token]/stage-labels
//
// Per-client custom names for the pipeline_stage enum. Token-in-path
// is the credential (same as every other /api/portal/<token>/* route).
// The body's `overrides` map can include any subset of the known
// stages — unknown keys are rejected so a stale client can't smuggle
// in junk that lingers in the jsonb. Empty / whitespace values are
// dropped on the server so the stored shape is always either the
// override OR nothing for that stage.

export const dynamic = "force-dynamic";

const STAGES = STAGE_ORDER as readonly PipelineStage[];

const bodySchema = z.object({
  overrides: z.record(z.string(), z.string()),
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

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  // Whitelist + sanitize: only known stages, trimmed, capped to the
  // shared max length. Drop empties so the stored JSON only contains
  // actual overrides.
  const allowed = new Set<string>(STAGES);
  const cleaned: Record<string, string> = {};
  for (const [key, raw] of Object.entries(parsed.data.overrides)) {
    if (!allowed.has(key)) {
      return NextResponse.json(
        { error: `Unknown stage: ${key}` },
        { status: 400 },
      );
    }
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) continue;
    cleaned[key] = trimmed.slice(0, STAGE_LABEL_MAX_LEN);
  }

  const admin = createAdminSupabase();
  /*
   * OS-ONLY ADDITION — the single deviation from the tool's copy of this file.
   *
   * This is the one portal write route that touches `clients` at all, and
   * `clients` is the table all 47 live portals resolve against: portal_token
   * is the URL, portal_enabled is the on switch, slug must not be "unknown".
   *
   * The patch below is built from `cleaned`, whose keys are whitelisted
   * against STAGE_ORDER a few lines up, so it can only ever contain
   * stage_label_overrides and updated_at. The guard therefore passes today and
   * the behaviour is bit-identical to the tool's. It is here for the edit that
   * has not happened yet: the moment somebody spreads a client row into this
   * patch, this throws instead of blanking a live portal's token.
   */
  const patch = {
    stage_label_overrides: cleaned,
    updated_at: new Date().toISOString(),
  };
  assertNoPortalColumns(patch);
  const { error } = await admin
    .from("clients")
    .update(patch)
    .eq("id", client.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, overrides: cleaned });
}
