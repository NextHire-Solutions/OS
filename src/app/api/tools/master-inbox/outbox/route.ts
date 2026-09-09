import { NextResponse } from "next/server";

import { drain, outboxHealth } from "@/lib/tools/master-inbox/outbox";

/*
 * The introduction outbox: what is waiting, and a retry.
 *
 * GET  reports pending and failed counts, plus how old the oldest waiting job
 *      is — the number that says whether the sweep is keeping up.
 * POST retries whatever was left behind by a lost process.
 *
 * The sweep is safe to call often: it claims a batch before working it, so two
 * overlapping runs cannot both send the same Slack notice, and a claim older
 * than five minutes is treated as abandoned.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  return NextResponse.json(await outboxHealth());
}

export async function POST() {
  return NextResponse.json(await drain());
}
