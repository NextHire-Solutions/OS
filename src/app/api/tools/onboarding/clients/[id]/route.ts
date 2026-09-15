import { NextResponse } from "next/server";
import { z } from "zod";

import { getClientDetail } from "@/lib/tools/onboarding/client-detail";
import {
  assignSalespersonByName,
  setClientMls,
  setClientPhoto,
  setCopyStatus,
  setTacName,
} from "@/lib/tools/onboarding/client-writes";
import { setClientStage } from "@/lib/tools/onboarding/stages";
import { setClientAccountManager } from "@/lib/tools/onboarding/people";
import { syncBisonImports } from "@/lib/tools/onboarding/db-sync";
import { ensureOnboardingScheduler } from "@/lib/tools/onboarding/scheduler";
import { getOnboardingPipeline } from "@/lib/tools/onboarding/pipeline";

/*
 * One client: the whole detail screen's read, and every profile edit on it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT HERE
 *
 * Here: nine columns on one `orch_clients` row — stage, account manager,
 * salesperson, TAC, MLS, photo and the copy-approval flag. Every one is a LABEL.
 * None triggers or skips any real work, none causes the live orchestrator to do
 * anything, and none reaches outside this database. (`status` is the
 * automation's own bookkeeping and is written in exactly one direction, on
 * approval — see client-writes.ts for why that direction is the safe one.)
 *
 * NOT here: the step actions — create portal, build team, launch campaign and
 * the rest. They live at ./steps. The email steps and the Stripe link are
 * switched off there pending explicit enablement; the others run. See
 * `lib/tools/onboarding/step-run.ts`.
 *
 * The GET does what the tool's page does first: `syncBisonImports()`, the
 * DB-app handshake that picks up "leads imported" flips on view. It reads
 * `bison_campaigns` and writes only `orch_clients`; with the pipeline in
 * automatic mode it also launches a campaign whose leads just landed, exactly
 * as the tool does on the same view.
 *
 * Gated by the workspace front door: everything under /api/tools/* is behind the
 * HMAC cookie checked in src/proxy.ts, so there is no `requireSession()` here —
 * the same as every other route in this folder.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  ensureOnboardingScheduler();
  await syncBisonImports().catch((e) => console.error("[onboarding] syncBisonImports on view failed:", e));
  const detail = await getClientDetail(id);
  // A missing client is a 404, so the screen can say "no such client" rather
  // than render an empty profile that looks like data loss.
  if (!detail) return NextResponse.json({ error: "client not found" }, { status: 404 });
  return NextResponse.json(detail);
}

/*
 * `.strict()` so a typo in a field name is a 400 rather than a silently ignored
 * no-op — the failure mode that makes a form look like it saved.
 */
const patchSchema = z
  .object({
    // Empty string means "no stage" — the same as the tool's own dropdown.
    stageId: z.string().nullable().optional(),
    accountManagerId: z.string().nullable().optional(),
    /** Find-or-create by name, which is what the tool's control does. */
    salespersonName: z.string().max(120).optional(),
    tacName: z.string().max(120).optional(),
    /** Codes only, picked from the `mls` table — free text builds an empty list in silence. */
    mls: z.array(z.string().max(40)).max(40).optional(),
    /** A data: URL from the browser's own resize, or an https link. Re-validated server-side. */
    photo: z.string().nullable().optional(),
    /**
     * Records the client's decision — and, in automatic pipeline mode, runs the
     * set-up chain, as the tool does. See client-writes.ts.
     */
    copyStatus: z.enum(["approved", "rejected"]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to change" });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const p = parsed.data;

  /*
   * Applied one at a time, stopping at the first failure. The screen sends one
   * field per press, so this is a sequence of one in practice — and saying "the
   * MLS saved, the TAC did not" is more useful than one ok/not-ok over a batch.
   */
  const edits: [boolean, () => Promise<{ ok: boolean; error?: string }>][] = [
    [p.stageId !== undefined, () => setClientStage(id, p.stageId ?? null)],
    [p.accountManagerId !== undefined, () => setClientAccountManager(id, p.accountManagerId ?? null)],
    [p.salespersonName !== undefined, () => assignSalespersonByName(id, p.salespersonName as string)],
    [p.tacName !== undefined, () => setTacName(id, p.tacName as string)],
    [p.mls !== undefined, () => setClientMls(id, p.mls as string[])],
    [p.photo !== undefined, () => setClientPhoto(id, p.photo ?? null)],
    [p.copyStatus !== undefined, () => setCopyStatus(id, p.copyStatus as "approved" | "rejected")],
  ];

  let chain: unknown;
  for (const [wanted, run] of edits) {
    if (!wanted) continue;
    const r = await run();
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    if ("chain" in r && r.chain) chain = r.chain;
  }

  getOnboardingPipeline.invalidate();
  return NextResponse.json(chain ? { ok: true, chain } : { ok: true });
}
