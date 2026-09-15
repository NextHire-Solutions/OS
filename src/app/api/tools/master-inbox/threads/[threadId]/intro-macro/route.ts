import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/workspace";
import { osTable } from "@/lib/clients/os-db";
import { createAdminSupabase } from "@/lib/supabase/admin";
import {
  hasIntroDetails,
  missingIntroFields,
  renderIntroMacroTemplate,
} from "@/lib/tools/master-inbox/inbox/intro-macro";

/*
 * What the composer's Introduce button needs, for this conversation.
 *
 * Answers with the macro already carrying the client's details, and the
 * address to Cc. The lead's values are deliberately left as `{{lead.*}}`
 * tokens: the composer resolves them with the same `substituteVariables` the
 * Templates picker uses, so a macro inserted by the button and one inserted
 * from the picker read identically.
 *
 * Always 200 when the caller is allowed to ask. "This client has no contact
 * yet" is an answer, not an error — the button renders it as a tooltip and
 * disables itself, and an error status would show as a failed request in the
 * console for a perfectly normal state.
 */

export const dynamic = "force-dynamic";

type Unavailable = { available: false; reason: string; clientName?: string };
type Available = {
  available: true;
  clientName: string;
  /** The macro, client details filled in, `{{lead.*}}` still to resolve. */
  body: string;
  /** The client contact's address, to merge into Cc. Null when not held. */
  cc: string | null;
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const session = await requireSession();
  const admin = createAdminSupabase();

  const { data: thread, error: threadErr } = await admin
    .from("threads")
    .select("id, workspace_id, client_id")
    .eq("id", threadId)
    .maybeSingle();
  if (threadErr) {
    return NextResponse.json({ error: threadErr.message }, { status: 500 });
  }
  if (!thread || thread.workspace_id !== session.activeWorkspace.id) {
    return NextResponse.json({ error: "No such conversation" }, { status: 404 });
  }

  const clientId = (thread.client_id as string | null) ?? null;
  if (!clientId) {
    return NextResponse.json<Unavailable>({
      available: false,
      reason: "This conversation is not assigned to a client yet.",
    });
  }

  const { data: miClient } = await admin
    .from("clients")
    .select("id, name")
    .eq("id", clientId)
    .maybeSingle();
  const clientName = (miClient?.name as string | undefined) ?? "this client";

  /*
   * The introduction details live on the OS record, keyed to the Master Inbox
   * client by `mi_client_id`. A missing table (migration 0005 not run) or a
   * client with no OS record are both "nothing to introduce with" rather than
   * failures.
   */
  let row: Record<string, unknown> | null = null;
  try {
    const { data, error } = await osTable("os_clients")
      .select("name, contact_name, contact_role, contact_email, brokerage")
      .eq("mi_client_id", clientId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    row = (data as Record<string, unknown> | null) ?? null;
  } catch {
    return NextResponse.json<Unavailable>({
      available: false,
      clientName,
      reason: `The introduction details for ${clientName} could not be read.`,
    });
  }

  if (!row) {
    return NextResponse.json<Unavailable>({
      available: false,
      clientName,
      reason: `${clientName} is not on the workspace roster, so it has no introduction details.`,
    });
  }

  const client = {
    name: (row.name as string | null) ?? clientName,
    contactName: (row.contact_name as string | null) ?? null,
    contactRole: (row.contact_role as string | null) ?? null,
    brokerage: (row.brokerage as string | null) ?? null,
  };

  if (!hasIntroDetails(client)) {
    const missing = missingIntroFields(client).join(" and ");
    return NextResponse.json<Unavailable>({
      available: false,
      clientName: client.name,
      reason: `Add ${client.name}'s ${missing} in Clients → Edit to use this.`,
    });
  }

  return NextResponse.json<Available>({
    available: true,
    clientName: client.name,
    body: renderIntroMacroTemplate(client),
    cc: ((row.contact_email as string | null) ?? "").trim() || null,
  });
}
