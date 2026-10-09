import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { clientsChanged } from "@/lib/clients/after-change";
import { editInboxRow, inboxRowsFor, InboxRowError } from "@/lib/clients/inbox-rows";
import { viewerRoles } from "@/lib/identity/viewer-roles";

/*
 * A client's Master Inbox rows (one per portal): names, spellings and
 * conversation counts, on the client's record (9 Oct — moved from Master
 * Inbox → Settings → Clients).
 *
 *   GET  ?clientId=                         the rows; admins and account managers
 *   POST { clientId, rowId, name?, aliases?, dryRun? }   admins only, like the
 *        tab it replaces. dryRun returns what would change and writes nothing.
 */
export const dynamic = "force-dynamic";

async function viewer(request: Request) {
  const s = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!s?.email) return null;
  const v = await viewerRoles(s.email);
  return { email: s.email.toLowerCase(), admin: v.admin, accountManager: v.accountManager };
}

const fail = (e: unknown) =>
  NextResponse.json({ error: e instanceof Error ? e.message : "Master Inbox could not be read" }, { status: e instanceof InboxRowError ? e.status : 502 });

export async function GET(request: Request) {
  const who = await viewer(request);
  if (!who) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!who.admin && !who.accountManager) return NextResponse.json({ error: "Only admins and account managers can see this." }, { status: 403 });
  const clientId = new URL(request.url).searchParams.get("clientId") ?? "";
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  try {
    return NextResponse.json({ rows: await inboxRowsFor(clientId), canEdit: who.admin });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request) {
  const who = await viewer(request);
  if (!who) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!who.admin) return NextResponse.json({ error: "Only admins can rename a Master Inbox row or change its spellings." }, { status: 403 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  const rowId = typeof body?.rowId === "string" ? body.rowId : "";
  if (!clientId || !rowId) return NextResponse.json({ error: "clientId and rowId are required." }, { status: 400 });
  const name = typeof body?.name === "string" ? body.name : undefined;
  const aliases = Array.isArray(body?.aliases) ? body.aliases.filter((a): a is string => typeof a === "string") : undefined;
  try {
    const result = await editInboxRow(clientId, rowId, { name, aliases }, who.email, body?.dryRun === true);
    if (result.saved) clientsChanged();
    return NextResponse.json({ ...result, rows: result.saved ? await inboxRowsFor(clientId) : undefined }, { status: result.ok || body?.dryRun === true ? 200 : 400 });
  } catch (e) {
    return fail(e);
  }
}
