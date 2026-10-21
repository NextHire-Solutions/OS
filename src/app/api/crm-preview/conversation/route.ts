import { NextResponse, type NextRequest } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { adminEmails } from "@/lib/identity/admin";
import { canSeeCrmPreview } from "@/lib/crm-preview/access";
import { admit, NO_STORE_HEADERS } from "@/lib/crm-preview/data-guard";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";

/*
 * GET /api/crm-preview/conversation?client=<portal id>&entry=<pipeline entry id>
 *
 * The email thread behind one pipeline entry, for the preview's conversation
 * panel. It used to call the portal's own feed with the portal's token — so
 * the page handed every previewed client's token to the browser, and a token
 * alone opens that client's live portal, writes included (21 Oct review).
 * Now the browser names the client and the entry; the server checks who is
 * asking and reads by id. No token leaves the server.
 *
 * Owners and the named reviewers only, as the page: anyone else a bare 404.
 * Read-only.
 */

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Message = {
  id: string;
  direction: "inbound" | "outbound";
  sender: string | null;
  sender_name: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  sent_at: string | null;
};

export async function GET(request: NextRequest) {
  const me = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!canSeeCrmPreview(me?.email, adminEmails())) return new NextResponse(null, { status: 404 });
  const who = (me?.email ?? "").toLowerCase();

  const params = request.nextUrl.searchParams;
  const client = params.get("client") ?? "";
  const entryId = params.get("entry") ?? "";
  if (!UUID.test(client) || !UUID.test(entryId)) return NextResponse.json({ error: "No such conversation." }, { status: 400, headers: NO_STORE_HEADERS });

  const gate = admit(who, "staff", "conversation", request.headers);
  if (!gate.ok) {
    console.warn(JSON.stringify({ tag: "[crm-preview] refused", kind: "conversation", who, client, reason: gate.reason }));
    return NextResponse.json({ error: gate.message }, { status: gate.status, headers: NO_STORE_HEADERS });
  }

  try {
    const admin = createAdminSupabase();
    const { data: portal } = await admin.from("clients").select("id, slug, portal_token").eq("id", client).maybeSingle();
    if (!portal || portal.slug === "unknown" || !portal.portal_token) return NextResponse.json({ error: "No such client portal." }, { status: 404, headers: NO_STORE_HEADERS });

    // The entry, scoped to this client: another client's entry id surfaces as not found.
    const { data: entry } = await admin.from("client_pipeline_entries").select("id, thread_id").eq("id", entryId).eq("client_id", client).maybeSingle();
    if (!entry) return NextResponse.json({ error: "No such conversation." }, { status: 404, headers: NO_STORE_HEADERS });
    if (!entry.thread_id) return NextResponse.json({ messages: [], reason: "no_thread" }, { headers: NO_STORE_HEADERS });

    const messages = await fetchAllRows<Message>(({ from, to }) =>
      admin
        .from("messages")
        .select("id, direction, sender, sender_name, subject, body_html, body_text, sent_at")
        .eq("thread_id", entry.thread_id as string)
        .order("sent_at", { ascending: true })
        .range(from, to),
    );
    return NextResponse.json({ messages }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    console.error("[crm-preview] conversation", err);
    return NextResponse.json({ error: "The conversation could not be read just now." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
