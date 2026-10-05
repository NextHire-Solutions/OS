import { moreContactsFrom } from "@/lib/tools/master-inbox/inbox/intro-macro";
import { NextResponse } from "next/server";
import { rosterRowForPortal } from "@/lib/tools/master-inbox/clients/roster-for-portal";

import { requireSession } from "@/lib/auth/workspace";
import { osTable } from "@/lib/clients/os-db";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { introSenderFor } from "@/lib/tools/master-inbox/inbox/intro-sender";
import {
  introReady,
  introText,
  introContactEmails,
  missingIntroFields,
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
  /*
   * Introductions go out from Nicole (Eddy, 5 Oct): the mailbox to put in
   * From for this conversation, or null with the reason when there is none
   * this platform can send from. See intro-sender.ts.
   */
  sender: { email: string; channelId: string | null; problem: string | null };
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
    .select("id, workspace_id, client_id, source_provider")
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
    // Any of the client's portals, not only the one the record links —
    // see lib roster-for-portal.
    const found = await rosterRowForPortal(
      clientId,
      (miClient?.name as string | undefined) ?? null,
      "name, contact_name, contact_role, contact_email, " +
        "contact2_name, contact2_role, contact2_email, " +
        "contact3_name, contact3_role, contact3_email, brokerage, intro_override, more_contacts",
    );
    if (found.error) throw new Error(found.error);
    row = found.row;
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
    // People 2-3 from their columns, then 4+ from more_contacts (OS migration 0028).
    extraContacts: [
      ...[2, 3].map((n) => ({
        name: str(`contact${n}_name`),
        role: str(`contact${n}_role`),
        email: str(`contact${n}_email`),
      })),
      ...moreContactsFrom(row?.more_contacts),
    ],
    brokerage: str("brokerage"),
    // The client's own pasted introduction, when set (OS migration 0026).
    introOverride: str("intro_override"),
  };

  if (!introReady(client)) {
    const missing = missingIntroFields(client).join(" and ");
    return NextResponse.json<Unavailable>({
      available: false,
      clientName: client.name,
      reason: `No intro template: add ${client.name}'s ${missing} in Clients → ${client.name} → Introduce to.`,
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
    body: introText(client),
    cc: introContactEmails(client).join(", ") || null,
    introductionLabelId: (introLabel?.id as string | undefined) ?? null,
    sender: await introSenderFor(admin, session.activeWorkspace.id, (thread.source_provider as string | null) ?? "emailbison"),
  });
}
