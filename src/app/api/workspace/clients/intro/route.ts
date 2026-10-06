import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { IntroOverrideError, introView, saveIntroOverride, saveIntroVariants } from "@/lib/clients/intro-override";
import { clientsChanged } from "@/lib/clients/after-change";

/*
 * A client's introduction, as the Introduce to tab shows it (1 Oct).
 *
 * GET ?clientId=            → the standard wording, the custom one if set,
 *                              and whether there is anything to send.
 * PUT { clientId, custom }  → save the client's own introduction; null or
 *                              blank goes back to the standard wording.
 * PUT { clientId, variants } → save the wording by market or person (0030).
 */
export const dynamic = "force-dynamic";

const fail = (e: unknown) =>
  e instanceof IntroOverrideError
    ? NextResponse.json({ error: e.message }, { status: 400 })
    : NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the introduction" }, { status: 502 });

export async function GET(request: Request) {
  const clientId = new URL(request.url).searchParams.get("clientId") ?? "";
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  try {
    return NextResponse.json(await introView(clientId));
  } catch (e) {
    return fail(e);
  }
}

export async function PUT(request: Request) {
  const session = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  if (clientId && body && "variants" in body) {
    try {
      const view = await saveIntroVariants(clientId, body.variants);
      clientsChanged();
      console.log(`[clients/intro] ${session.email} saved ${view.variants.length} intro variant(s) for ${clientId}`);
      return NextResponse.json({ ok: true, view });
    } catch (e) {
      return fail(e);
    }
  }
  const custom = body?.custom === null ? null : typeof body?.custom === "string" ? body.custom : undefined;
  if (!clientId || custom === undefined) {
    return NextResponse.json({ error: "clientId and custom (text or null) are required." }, { status: 400 });
  }
  try {
    const result = await saveIntroOverride(clientId, custom);
    clientsChanged();
    console.log(`[clients/intro] ${session.email} ${result.view.custom ? "set a custom" : "restored the standard"} introduction for ${clientId}`);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return fail(e);
  }
}
