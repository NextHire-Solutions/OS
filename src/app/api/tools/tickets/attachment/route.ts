import { NextResponse, type NextRequest } from "next/server";

import { osTable } from "@/lib/clients/os-db";
import type { Attachment, GmailPart } from "@/lib/tools/tickets/gmail-message";
import { failure, ticketsViewer } from "@/lib/tools/tickets/route-auth";
import { gmailForMailbox } from "@/lib/tools/tickets/runner";

/*
 * GET /api/tools/tickets/attachment?m=<message id>&p=<part id>[&inline=1]
 *
 * Attachments are never stored: fetched from the Gmail of a teammate whose inbox holds the email (the viewer's
 * own first), when someone opens one. Gmail's attachment ids change between reads, so the message is read again
 * to find the part. Only plain images may show inline (an email's cid: pictures); everything else downloads,
 * sandboxed, so a file can never run as part of the OS.
 */
export const dynamic = "force-dynamic";

const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 30 * 1024 * 1024;

function findPart(p: GmailPart | undefined, partId: string): GmailPart | null {
  if (!p) return null;
  if ((p.partId ?? "") === partId && !p.parts?.length) return p;
  for (const c of p.parts ?? []) {
    const hit = findPart(c, partId);
    if (hit) return hit;
  }
  return null;
}

export async function GET(request: NextRequest) {
  const viewer = await ticketsViewer(request);
  if (viewer instanceof NextResponse) return viewer;
  const m = request.nextUrl.searchParams.get("m") ?? "";
  const part = request.nextUrl.searchParams.get("p") ?? "";
  const inline = request.nextUrl.searchParams.get("inline") === "1";
  if (!UUID.test(m) || !/^[\d.]{1,40}$/.test(part)) return NextResponse.json({ error: "No such attachment" }, { status: 404 });
  try {
    const [{ data: msg }, { data: copies }] = await Promise.all([
      osTable("os_ticket_messages").select("attachments").eq("id", m).maybeSingle(),
      osTable("os_ticket_copies").select("mailbox, gmail_id").eq("message_id", m),
    ]);
    const meta = ((msg as { attachments?: Attachment[] } | null)?.attachments ?? []).find((a) => a.partId === part);
    if (!meta) return NextResponse.json({ error: "No such attachment" }, { status: 404 });
    const cs = ((copies ?? []) as Array<{ mailbox: string; gmail_id: string }>).sort((a, b) => Number(b.mailbox.toLowerCase() === viewer.email) - Number(a.mailbox.toLowerCase() === viewer.email));
    const { data: boxes } = await osTable("os_ticket_mailboxes").select("email, token_enc, state").in("email", cs.map((c) => c.mailbox));
    const usable = new Map(((boxes ?? []) as Array<{ email: string; token_enc: string | null; state: string }>).filter((b) => b.token_enc && b.state !== "paused").map((b) => [b.email.toLowerCase(), b]));
    for (const c of cs) {
      const box = usable.get(c.mailbox.toLowerCase());
      if (!box) continue;
      const gmail = gmailForMailbox(box);
      if (!gmail) continue;
      try {
        const full = await gmail.full(c.gmail_id);
        const p = findPart(full.payload, part);
        if (!p) continue;
        const data = p.body?.attachmentId ? (await gmail.attachment(c.gmail_id, p.body.attachmentId)).data : p.body?.data;
        if (!data) continue;
        const bytes = Buffer.from(data, "base64url");
        if (bytes.length > MAX_BYTES) return NextResponse.json({ error: "This file is too large to open here. Open it in Gmail." }, { status: 413 });
        const mime = (meta.mime || "application/octet-stream").toLowerCase();
        const asInline = inline && INLINE.has(mime);
        const name = (meta.filename || "attachment").replace(/[\r\n"\\/]/g, "_").slice(0, 150);
        return new NextResponse(new Uint8Array(bytes), {
          headers: {
            "Content-Type": asInline ? mime : mime.startsWith("image/") || mime === "application/pdf" ? mime : "application/octet-stream",
            "Content-Disposition": `${asInline ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            "Content-Length": String(bytes.length),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:",
            "Cache-Control": "private, max-age=3600",
          },
        });
      } catch {
        continue;
      }
    }
    return NextResponse.json({ error: "No connected inbox can open this file right now. Open it in Gmail." }, { status: 409 });
  } catch (e) {
    return failure(e);
  }
}
