import { NextResponse } from "next/server";
import { z } from "zod";

import { setClientStage } from "@/lib/tools/onboarding/stages";
import { setClientAccountManager } from "@/lib/tools/onboarding/people";

/*
 * One client on the pipeline: the two manual moves the team makes constantly.
 *
 * Both are LABELS. Moving a client between stages does not trigger or skip any
 * real work — `orch_clients.status` is the automation's own bookkeeping and is
 * untouched here — and the account manager is read by nothing automatic. That is
 * the tool's design, not a limitation of this port: see
 * lib/tools/onboarding/stages.ts.
 *
 * Deliberately NOT here: the fourteen step actions (send welcome, build team,
 * launch campaign…). Those call EmailBison, Stripe, Gmail and the Client Portal
 * with hub tokens the workspace does not hold, and they live on the client
 * detail page, which this port does not carry. See ONBOARDING-PARITY.md.
 */
export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    // Empty string means "no stage" — the same as the tool's own dropdown.
    stageId: z.string().nullable().optional(),
    accountManagerId: z.string().nullable().optional(),
  })
  .strict()
  .refine((v) => v.stageId !== undefined || v.accountManagerId !== undefined, {
    message: "nothing to change",
  });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  if (parsed.data.stageId !== undefined) {
    const r = await setClientStage(id, parsed.data.stageId);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  }
  if (parsed.data.accountManagerId !== undefined) {
    const r = await setClientAccountManager(id, parsed.data.accountManagerId);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
