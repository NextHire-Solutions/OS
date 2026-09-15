import { NextResponse, type NextRequest } from "next/server";

import {
  createClientRow,
  deleteClientRow,
  updateClientRow,
  type WriteResult,
} from "@/lib/tools/client-health/clientWrites";
import { checkReadToken, listClientRows } from "@/lib/tools/client-health/publish";
import { getSupabase } from "@/lib/tools/client-health/supabase";
import { getWeekly } from "@/lib/tools/client-health/weekly";

/*
 * Every write the workspace makes to Client Health.
 *
 * ---------------------------------------------------------------------------
 * THIS USED TO BE A PROXY
 *
 * It forwarded each write to the live Client Health app's own `/api/clients`,
 * on the reasoning that the tool held the validation and the cascade rules and
 * the OS should have no opinion about what a valid client is.
 *
 * The architecture changed underneath that reasoning. Client Health is being
 * switched off and the OS is taking it over, which makes the proxy a dependency
 * on something that will stop answering. When it does, the failure is not loud:
 * the screen still loads — reads come from the database directly — and only
 * saving, pausing, churning and deleting break, one toast at a time.
 *
 * So the rules moved into `clientWrites.ts` rather than the traffic moving
 * through a doomed hop. Read that file before changing anything here: it
 * documents what a DELETE actually removes, and the one place this deliberately
 * diverges from the tool (`time_zone` on create, which the tool drops).
 *
 * There is no auth check in this file. Everything under /api/tools/* is behind
 * the workspace's front door — the signed cookie checked in `src/proxy.ts` —
 * so by the time a handler here runs the caller is signed in.
 */
export const dynamic = "force-dynamic";

/*
 * GET — the tool's published roster, `{ clients }`, every column of every
 * client ordered by name.
 *
 * The tool accepts two callers here: a signed-in person, or a machine holding
 * READ_ONLY_TOKEN in `x-admin-token`. The proxy has already established the
 * first; the second is honoured too, so a consumer that read the tool's
 * /api/clients with a token can read this one with the same header — the
 * workspace's name for that secret is CLIENT_HEALTH_READ_TOKEN. Writes below
 * never accept the token: a secret handed to lower-trust readers must not be
 * able to delete a client.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.headers.get("x-admin-token");
  if (token !== null && checkReadToken(token) !== "ok") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    getSupabase();
    return NextResponse.json({ clients: await listClientRows() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client Health is unreachable" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return respond(async (db) => createClientRow(db, await readJson(request)), 201, (v) => ({
    client: v,
  }));
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  return respond(async (db) => updateClientRow(db, await readJson(request)), 200, (v) => ({
    client: v,
  }));
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const id = request.nextUrl.searchParams.get("id");
  // Refused here rather than guessed: a DELETE with no id is a bug in the
  // caller, and this one cascades.
  if (!id) {
    return NextResponse.json({ error: "A client id is required" }, { status: 400 });
  }
  return respond((db) => deleteClientRow(db, id), 200, (v) => ({ ok: true, ...v }));
}

/**
 * Runs one write and turns its result into a response.
 *
 * The body shapes — `{ client }` and `{ ok, orphansRemoved }` — are the live
 * tool's, unchanged, because the browser code reads them: `saveClient` needs
 * `client.id` to add the new row without a reload, and `removeClient` reports
 * the orphan count in its toast.
 */
async function respond<T>(
  run: (db: ReturnType<typeof getSupabase>) => Promise<WriteResult<T>>,
  okStatus: number,
  shape: (value: T) => Record<string, unknown>,
): Promise<NextResponse> {
  /*
   * Every write drops the cached read.
   *
   * `getWeekly` is a 60-second ttlCache, and nothing invalidated it. Add a
   * client, press reload inside a minute: the client is gone. Churn one: the
   * churn looks undone. Edit one: the edit looks lost. The write had landed —
   * the next read was simply served from a cache that predated it, and the
   * screen then flipped between the two depending on which path it took.
   *
   * The tool itself never had this problem because its page is force-dynamic
   * and every mutation calls router.refresh().
   */
  let db: ReturnType<typeof getSupabase>;
  try {
    db = getSupabase();
  } catch (error) {
    // A missing credential is a deployment problem, not a bad request. 501
    // keeps it out of the "your input was wrong" bucket.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Client Health is not configured" },
      { status: 501 },
    );
  }

  try {
    const result = await run(db);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    getWeekly.invalidate();
    return NextResponse.json(shape(result.value), { status: okStatus });
  } catch (error) {
    console.error("[api/tools/client-health/clients]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The write could not be completed" },
      { status: 502 },
    );
  }
}

/** Body parsing that fails as invalid input rather than as an exception. */
async function readJson(request: NextRequest): Promise<unknown> {
  return request.json().catch(() => null);
}
