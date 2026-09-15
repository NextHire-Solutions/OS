import { NextResponse } from "next/server";

import { getLeadPreview } from "@/lib/tools/onboarding/client-leads";

/*
 * The lead list built for one client, for human review before the DB app takes
 * it. Read-only, and separate from the client's own payload because it is the
 * one part of this screen measured in hundreds of rows.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  // getLeadPreview describes its own failure rather than throwing, so the tab
  // can say what went wrong instead of showing an empty list.
  return NextResponse.json(await getLeadPreview(id));
}
