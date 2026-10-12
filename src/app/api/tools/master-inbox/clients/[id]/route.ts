import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { assertPortalUrlStable, PortalGuardError } from "@/lib/tools/master-inbox/portal-guard";
import { _invalidateClientCache } from "@/lib/clients/derive";
import { invalidateInboxClientsCache } from "@/lib/inbox/clients";
import { CLIENT_PORTALS_ENABLED } from "@/lib/portals/flag";
import { withFeatureFlag } from "@/lib/tools/master-inbox/portals/feature-flags";
import { TEAM_SMS_FLAG } from "@/lib/tools/master-inbox/portals/team-sms";
import { requireAuthedUser, retagUnknownThreads } from "../route";
import { isAdminUser } from "@/lib/identity/admin-db";
import { deletePortal, PortalDeleteRefused } from "@/lib/clients/delete-portal";
import { clientsChanged } from "@/lib/clients/after-change";

// PATCH  /api/clients/[id]   -> rename + edit aliases, portal URL / on-off,
//                               SMS alerts on-off (Client Portals page)
// DELETE /api/clients/[id]   -> delete this ONE portal and leave the client
//                               (admins; body { confirm, acceptDataLoss } —
//                               see lib/clients/delete-portal.ts). Threads
//                               referencing it keep client_id NULL via the
//                               FK's ON DELETE SET NULL.
//
// The "Unknown" row (slug='unknown') is protected: rename/delete on it
// returns 400 because it's the system fallback target.

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  // Client portal access. portal_token is the secret path segment in
  // /portal/<token> — min 8 chars + URL-safe so it can't be trivially
  // guessed. portal_enabled toggles the portal without losing the token.
  portal_token: z
    .string()
    .trim()
    .min(8, "Portal URL must be at least 8 characters")
    .max(120)
    .regex(/^[a-zA-Z0-9_-]+$/, "Only letters, numbers, hyphens and underscores")
    .optional(),
  portal_enabled: z.boolean().optional(),
  // SMS alerts for this client (Client Portals page "SMS" switch). Stored
  // as the team_sms_notifications feature flag: on = the portal Team page
  // shows per-member SMS switches and Introductions are texted to the
  // members switched on; off = no texts. See portals/team-sms.ts.
  // The same field, the same flag and the same rules as the standalone
  // Master Inbox's route (c4b6b77) — both apps write one column.
  sms_alerts: z.boolean().optional(),
});

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "client";
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthedUser();
  if ("error" in auth) return auth.error;
  const { id } = await context.params;

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const admin = createAdminSupabase();
  const { data: existing } = await admin
    .from("clients")
    .select("id, name, slug, feature_flags")
    .eq("id", id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }
  if (existing.slug === "unknown" && parsed.data.name && parsed.data.name !== existing.name) {
    return NextResponse.json(
      { error: "The 'Unknown' fallback client can't be renamed." },
      { status: 400 },
    );
  }

  const update: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) {
    update.name = parsed.data.name;
    update.slug = toSlug(parsed.data.name);
  }
  if (parsed.data.aliases !== undefined) {
    update.aliases = parsed.data.aliases;
  }
  // Portal fields are only honoured when the Client Portals feature is
  // live (migration 0016 may not be applied otherwise).
  if (CLIENT_PORTALS_ENABLED) {
    if (parsed.data.portal_token !== undefined) {
      if (existing.slug === "unknown") {
        return NextResponse.json(
          { error: "The 'Unknown' fallback client has no portal." },
          { status: 400 },
        );
      }
      update.portal_token = parsed.data.portal_token;
    }
    if (parsed.data.portal_enabled !== undefined) {
      update.portal_enabled = parsed.data.portal_enabled;
    }
    if (parsed.data.sms_alerts !== undefined) {
      if (existing.slug === "unknown") {
        return NextResponse.json(
          { error: "The 'Unknown' fallback client has no portal." },
          { status: 400 },
        );
      }
      // Rewrites the whole flags map with this one key changed. Every other
      // writer of this column in the OS merges (withStandardFlags only ADDS
      // absent keys), so none of them can drop this one; a concurrent edit
      // losing out here is not a realistic case.
      update.feature_flags = withFeatureFlag(
        existing.feature_flags,
        TEAM_SMS_FLAG,
        parsed.data.sms_alerts,
      );
    }
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  /*
   * The portal's URL is its token, and this client already has one in
   * circulation. Rewriting it would dead-link whatever the client has
   * bookmarked, with nothing to tell them the new address.
   *
   * Everything else this editor writes stays allowed — including `slug`, which
   * a rename legitimately derives, and `portal_enabled`, which is a reversible
   * switch a person is choosing to flip.
   */
  try {
    assertPortalUrlStable(update);
  } catch (guardError) {
    if (guardError instanceof PortalGuardError) {
      return NextResponse.json({ error: guardError.message }, { status: 409 });
    }
    throw guardError;
  }

  const { data, error } = await admin
    .from("clients")
    .update(update)
    .eq("id", id)
    .select("id, name, slug, aliases")
    .single();
  if (error) {
    // 23505 = unique violation (duplicate name OR duplicate portal_token).
    return NextResponse.json(
      {
        error:
          error.code === "23505"
            ? "That portal URL (or name) is already taken — pick another."
            : error.message,
      },
      { status: error.code === "23505" ? 409 : 500 },
    );
  }

  _invalidateClientCache();
  // Also bust the Inbox's client-list cache so the per-thread Client
  // filter dropdown shows the new name immediately. Without this,
  // renames take up to 60s to surface in the inbox UI.
  invalidateInboxClientsCache();
  // Propagate the rename to every saved list that's backed by this
  // client (lists.client_id = id). Each list keeps its own copy of
  // the name on the row, so without this the left-sidebar list keeps
  // displaying the old client name. Lists with a NULL client_id
  // (user-created custom lists not tied to a client) are skipped by
  // the WHERE.
  if (parsed.data.name !== undefined && parsed.data.name !== existing.name) {
    const { error: listsErr } = await admin
      .from("lists")
      .update({ name: parsed.data.name, updated_at: new Date().toISOString() })
      .eq("client_id", id);
    if (listsErr) {
      // Don't fail the request — the client rename already
      // succeeded, the sidebar will just stay stale on the next
      // render. Log so we can spot a persistent failure.
      console.error("[clients/rename] failed to propagate to lists", listsErr);
    }
  }
  // Aliases changed → existing "Unknown" threads might now match.
  if (parsed.data.aliases !== undefined || parsed.data.name !== undefined) {
    await retagUnknownThreads(admin, id);
  }
  return NextResponse.json({ ok: true, client: data });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthedUser();
  if ("error" in auth) return auth.error;
  /*
   * Deleting ONE portal, and leaving the client (13 Oct: "Add the ability to
   * delete client portals" — "Portal only, client stays", admins only).
   *
   * It cascades the portal's pipeline, agents, DNC list and team, with no
   * undo, and the "not live" guard is one PATCH away from passing — anyone
   * with Client Portals can switch a portal off. So the delete itself is for
   * admins, and it is checked HERE as well as in the page: the page only
   * decides whether the button is drawn.
   */
  if (!(await isAdminUser(auth.user.email))) {
    return NextResponse.json({ error: "Only workspace admins can delete a portal." }, { status: 403 });
  }
  const { id } = await context.params;

  // The typed name and the acknowledgement travel in the body. A bare DELETE
  // — a script, a replayed request, the old client — is refused below for
  // having typed nothing, which is the point.
  const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const confirm = typeof body.confirm === "string" ? body.confirm : "";

  /*
   * Every rule is in lib/clients/delete-portal.ts, re-read at this moment:
   * the Unknown bucket and the Demo Portal are never deleted, a LIVE portal is
   * refused until it is switched off, the name must be typed exactly, and a
   * portal that holds anything needs the acknowledgement too.
   */
  let result;
  try {
    result = await deletePortal(id, {
      confirm,
      // Only ever true when the caller ticked the box; anything else (missing,
      // "true", 1) stays false and the gate holds.
      acceptDataLoss: body.acceptDataLoss === true,
      by: auth.user.email ?? null,
    });
  } catch (error) {
    if (error instanceof PortalDeleteRefused) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The portal could not be deleted" },
      { status: 500 },
    );
  }

  _invalidateClientCache();
  // The inbox's Client filter and Clients panel list this row too.
  invalidateInboxClientsCache();
  // The client record may have changed (its stored link), and every count on
  // the Consistency page and the tools' count lines just moved by one.
  clientsChanged();
  // 200 even when a follow-up step failed: the portal IS gone, and saying
  // otherwise would invite a second attempt at something already done.
  return NextResponse.json({ ok: true, ...result });
}
