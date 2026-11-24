import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";

import { loadTemplate, saveTemplate } from "@/lib/clients/prospect-sync/setup-campaign";
import { clientFieldValuesForCampaign } from "@/lib/tools/analytics/campaigns/client-fields-load";
import { createEmailBisonClient } from "@/lib/tools/analytics/emailbison/client";
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

/*
 *   GET ?sequence=1                      also: the template's emails as EmailBison holds them NOW (read live — the synced
 *                                        copy can lag a save by an hour), and the client it is assigned to, if any
 *                                        (Campaign Management › New-client template — the client's request: "a section
 *                                        in the OS where I can view and edit the default campaign template"). Reads only.
 */
type TemplateStep = { id: number; order: number; email_subject: string; email_body: string; wait_in_days: number; variant: boolean; variant_from_step_id: number | null; thread_reply: boolean; active: boolean };

async function templateSequence(campaignId: number): Promise<{ sequenceId: number | null; steps: TemplateStep[] }> {
  const payload = await createEmailBisonClient().getCampaignSequenceSteps(campaignId);
  const raw = (payload?.data?.sequence_steps ?? []) as unknown as Array<Record<string, unknown>>;
  const steps = raw.map((s): TemplateStep => ({
    id: Number(s.id), order: Number(s.order) || 0, email_subject: String(s.email_subject ?? ""), email_body: String(s.email_body ?? ""),
    wait_in_days: Number(s.wait_in_days) || 0, variant: Boolean(s.variant), variant_from_step_id: s.variant_from_step_id ? Number(s.variant_from_step_id) : null,
    thread_reply: Boolean(s.thread_reply), active: s.active !== false,
  }));
  // Each email, then its A/B versions — the order the editor lists them in.
  const mains = steps.filter((s) => !s.variant).sort((a, b) => a.order - b.order || a.id - b.id);
  const ordered = mains.flatMap((m) => [m, ...steps.filter((v) => v.variant && v.variant_from_step_id === m.id).sort((a, b) => a.order - b.order || a.id - b.id)]);
  const orphans = steps.filter((s) => !ordered.includes(s));
  const id = Number(payload?.data?.sequence_id);
  return { sequenceId: Number.isFinite(id) && id > 0 ? id : null, steps: [...ordered, ...orphans] };
}

export async function GET(request: NextRequest) {
  if (!(await who())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const template = await loadTemplate();
    if (!template || request.nextUrl.searchParams.get("sequence") !== "1") return NextResponse.json({ template }, { headers: NO_STORE });
    const id = Number(template.campaignId);
    const [sequence, client] = await Promise.all([
      templateSequence(id).then((v) => ({ ok: true as const, ...v })).catch((e) => ({ ok: false as const, error: describeEmailBisonError(e) })),
      // A template is a campaign with NO client: saving one that is assigned to a client would fill that client's area in for good.
      clientFieldValuesForCampaign("emailbison", id).then((v) => ({ name: v.clientName })).catch(() => ({ name: null, unread: true })),
    ]);
    return NextResponse.json({ template, sequence, client }, { headers: NO_STORE });
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
