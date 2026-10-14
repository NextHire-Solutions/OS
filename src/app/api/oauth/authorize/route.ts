import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { connectorUserCheck } from "@/lib/mcp/access";
import { approve, checkAuthorizeRequest, deny, publicOrigin } from "@/lib/mcp/oauth";

/*
 * Allow / Cancel on "Connect Claude" (app/oauth/authorize/page.tsx).
 *
 * NOT open at the proxy: it runs on the person's OS session, like any other
 * OS action. Everything the page checked is checked again here — the form's
 * hidden fields are the browser's to edit — and the session cookie is
 * SameSite=Lax, so another site cannot press Allow for someone. The Origin
 * check says the same thing a second way.
 */

export const dynamic = "force-dynamic";

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return plain(503, "The OS is not configured to sign anyone in.");

  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  const ours = [publicOrigin(), new URL(request.url).origin, host ? `${proto}://${host}` : ""];
  if (origin && origin !== "null" && !ours.includes(origin)) return plain(403, "This form can only be sent from BrokerStaffer OS.");

  const me = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!me) return plain(401, "Sign in to BrokerStaffer OS first.");

  const fields = new URLSearchParams(await request.text());
  const checked = await checkAuthorizeRequest(secret, (name) => fields.get(name));
  if (!checked.ok) {
    return checked.redirect ? NextResponse.redirect(checked.redirect, 303) : plain(400, checked.message);
  }

  if (fields.get("decision") !== "allow") {
    return NextResponse.redirect(deny(checked.request), 303);
  }

  const user = await connectorUserCheck(me.email);
  if (!user.ok) return plain(403, user.reason);

  console.info(`[mcp-auth] ${me.email} connected ${checked.request.clientName}`);
  return NextResponse.redirect(await approve(secret, checked.request, me.email), 303);
}
