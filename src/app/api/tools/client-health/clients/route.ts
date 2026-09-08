import { NextResponse, type NextRequest } from "next/server";

import { callClientHealth } from "@/lib/tools/client-health/session";
import { NotConfiguredError } from "@/lib/env";

/*
 * Every write the workspace makes to Client Health.
 *
 * A thin proxy onto the tool's own /api/clients, on purpose. That endpoint
 * holds the validation, the campaign auto-linking and the cascade rules for a
 * delete. Writing to the database directly would bypass all of it, and the
 * failure would be silent — a client row that looks right and behaves wrongly.
 *
 * So the body is passed through untouched and the tool's response is returned
 * as it comes. The workspace adds authentication and nothing else; it has no
 * opinion about what a valid client is, and should not develop one.
 *
 * The proxy has already verified the workspace session before this runs, and
 * the credential for Client Health never reaches the browser.
 */
export const dynamic = "force-dynamic";

async function proxy(request: NextRequest, method: "POST" | "PATCH"): Promise<NextResponse> {
  const body = await request.text();
  return relay(
    callClientHealth("/api/clients", {
      method,
      headers: { "content-type": "application/json" },
      body,
      timeoutMs: 30_000,
    }),
  );
}

export const POST = (request: NextRequest) => proxy(request, "POST");
export const PATCH = (request: NextRequest) => proxy(request, "PATCH");

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const id = request.nextUrl.searchParams.get("id");
  // Refused here rather than forwarded: a DELETE with no id is a bug in the
  // caller, and the one thing worse than failing is guessing which client.
  if (!id) {
    return NextResponse.json({ error: "A client id is required" }, { status: 400 });
  }
  return relay(
    callClientHealth(`/api/clients?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      timeoutMs: 30_000,
    }),
  );
}

/** Returns the tool's own answer, with its status, so nothing is invented. */
async function relay(pending: Promise<Response>): Promise<NextResponse> {
  try {
    const res = await pending;
    const text = await res.text();
    const body = text ? safeParse(text) : null;

    if (!res.ok) {
      return NextResponse.json(
        {
          error:
            (body && typeof body === "object" && "error" in body
              ? String((body as { error: unknown }).error)
              : null) ??
            // A 401 here means OUR credential is wrong, not the user's — say so
            // rather than showing them an authentication error they cannot act on.
            (res.status === 401
              ? "The workspace could not authenticate to Client Health"
              : `Client Health returned ${res.status}`),
        },
        { status: res.status === 401 ? 502 : res.status },
      );
    }

    return NextResponse.json(body ?? { ok: true });
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return NextResponse.json(
        { error: `Not configured — set ${error.varName}` },
        { status: 501 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client Health is unreachable" },
      { status: 502 },
    );
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}
