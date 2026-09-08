import { NextResponse } from "next/server";

import { callClientHealth } from "@/lib/tools/client-health/session";
import { NotConfiguredError } from "@/lib/env";

/*
 * "Sync now" — triggers Client Health's OWN sync worker.
 *
 * The workspace deliberately does not reimplement the sync. `runSync()` walks
 * Instantly and EmailBison, reconciles campaigns and pulls introductions from
 * Corofy; a second implementation of that would drift, and the way you would
 * find out is two dashboards disagreeing about a client's numbers.
 *
 * So this is a proxy: the workspace authenticates as a signed-in person and
 * presses the same button the tool's own dashboard presses. Whatever the tool
 * does today, this does.
 *
 * It is slow by nature — thousands of upstream calls — hence the long timeout.
 * Reporting a failure for a sync that actually completed would be worse than
 * waiting, because someone would press it again.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  try {
    const res = await callClientHealth("/api/sync/run", {
      method: "POST",
      timeoutMs: 240_000,
    });

    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: unknown; error?: string }
      | null;

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: body?.error ?? `Client Health returned ${res.status}` },
        { status: res.status === 401 ? 502 : res.status },
      );
    }

    return NextResponse.json({ ok: true, result: body?.result ?? null });
  } catch (error) {
    // A missing variable is our gap, not the tool's fault, and says which one.
    if (error instanceof NotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: `Sync is not configured — set ${error.varName}` },
        { status: 501 },
      );
    }
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "The sync is taking longer than four minutes. It is still running — check Client Health for the result rather than starting another."
        : error instanceof Error
          ? error.message
          : "Sync failed";
    return NextResponse.json({ ok: false, error: message }, { status: 504 });
  }
}
