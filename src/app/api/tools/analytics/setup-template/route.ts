import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";

import { loadTemplate, saveTemplate } from "@/lib/clients/prospect-sync/setup-campaign";
import { describeEmailBisonError } from "@/lib/tools/analytics/emailbison/errors";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/tools/analytics/session";

/*
 * The setup template (2 Nov): the EmailBison campaign a new client's first campaign is a draft copy of, made when it
 * finishes setting up its portal (lib/clients/prospect-sync/setup-campaign.ts).
 *
 *   GET                                  the template now (or null)
 *   POST { campaignId, confirm: true }   make this campaign the template (read back from EmailBison first)
 *
 * Session-auth as Campaign Management's other writes, with an explicit confirmation.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

async function who(): Promise<string | null> {
  const store = await cookies();
  const session = await verifySessionToken(process.env.AUTH_SECRET ?? "", store.get(AUTH_COOKIE)?.value);
  return session?.email ?? null;
}

export async function GET() {
  if (!(await who())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ template: await loadTemplate() }, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not read the template." }, { status: 502, headers: NO_STORE });
  }
}

const Body = z.object({ campaignId: z.number().int().positive(), confirm: z.literal(true) });

export async function POST(request: NextRequest) {
  const email = await who();
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Send the campaign's EmailBison id, with confirm: true." }, { status: 400 });
  try {
    const template = await saveTemplate(parsed.data.campaignId, email);
    console.info(JSON.stringify({ tag: "[prospect-sync] template", by: email, campaign: template.campaignId }));
    return NextResponse.json({ template }, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json({ error: describeEmailBisonError(err) }, { status: 502, headers: NO_STORE });
  }
}
