import { NextResponse } from "next/server";

import { isAdminUser } from "@/lib/identity/admin-db";
import { planPortalDelete } from "@/lib/clients/delete-portal";
import { requireAuthedUser } from "../../route";

/*
 * GET /api/tools/master-inbox/clients/[id]/delete-plan
 *
 * What deleting this ONE portal would do — what goes, what stays, and whether
 * it is allowed at all — so the dialog can show it before asking. Changes
 * nothing. Admins only, like the delete itself (../route.ts): the answer names
 * what is inside a client's portal.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthedUser();
  if ("error" in auth) return auth.error;
  if (!(await isAdminUser(auth.user.email))) {
    return NextResponse.json({ error: "Only workspace admins can delete a portal." }, { status: 403 });
  }
  const { id } = await context.params;
  try {
    const plan = await planPortalDelete(id);
    if (!plan) return NextResponse.json({ error: "That portal no longer exists." }, { status: 404 });
    return NextResponse.json(plan);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read the portal" },
      { status: 502 },
    );
  }
}
