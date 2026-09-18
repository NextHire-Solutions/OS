import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/workspace";
import { osTable } from "@/lib/clients/os-db";
import { createAdminSupabase } from "@/lib/supabase/admin";
import {
  hasIntroDetails,
  introContactEmails,
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
  /**
   * Every named contact's address, comma-separated, to merge into Cc. Null
   * when none of them has one.
   */
  cc: string | null;
  /*
   * The workspace's "Introduction" label, so the composer can apply it once
   * the introduction has actually been sent. Null when the workspace has no
   * such label, in which case the composer simply does not label — it never
   * invents one, because creating a label here would start the introduction
   * machinery (portal pipeline, Follow Up Boss) on a workspace that has
   * deliberately not set it up.
   */
  introductionLabelId: string | null;
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
      .select(
        "name, contact_name, contact_role, contact_email, " +
          "contact2_name, contact2_role, contact2_email, " +
          "contact3_name, contact3_role, contact3_email, brokerage",
      )
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

  const str = (k: string) => (row?.[k] as string | null) ?? null;
  const client = {
    name: (row.name as string | null) ?? clientName,
    contactName: str("contact_name"),
    contactRole: str("contact_role"),
    contactEmail: str("contact_email"),
    // The second and third people, when this client has them. Anyone without
    // both a name and a role is ignored by the macro.
    extraContacts: [2, 3].map((n) => ({
      name: str(`contact${n}_name`),
      role: str(`contact${n}_role`),
      email: str(`contact${n}_email`),
    })),
    brokerage: str("brokerage"),
  };

  if (!hasIntroDetails(client)) {
    const missing = missingIntroFields(client).join(" and ");
    return NextResponse.json<Unavailable>({
      available: false,
      clientName: client.name,
      reason: `Add ${client.name}'s ${missing} in Clients → Edit to use this.`,
    });
  }

  const { data: introLabel } = await admin
    .from("labels")
    .select("id")
    .eq("workspace_id", session.activeWorkspace.id)
    .ilike("name", "Introduction")
    .maybeSingle();

  return NextResponse.json<Available>({
    available: true,
    clientName: client.name,
    body: renderIntroMacroTemplate(client),
    cc: introContactEmails(client).join(", ") || null,
    introductionLabelId: (introLabel?.id as string | undefined) ?? null,
  });
}
