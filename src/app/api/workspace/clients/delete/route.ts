import { NextResponse } from "next/server";

import { deleteClient, planDelete, type DeleteScope } from "@/lib/clients/delete";

/*
 * Deleting a client. The only irreversible action in the workspace.
 *
 * GET  — what a delete WOULD do, so the dialog can show it before asking.
 * POST — do it, with the client's name typed back, and for the "everything"
 *        scope an explicit acknowledgement when the portal holds real data.
 *
 * "everything" removes the Master Inbox row and with it the live portal URL,
 * plus everything cascading from it: the pipeline, the agent roster, the DNC
 * list and the team. The token is random and unrecoverable. See
 * lib/clients/delete.ts for the counts that gate it.
 */
export const dynamic = "force-dynamic";

const SCOPES: DeleteScope[] = ["os", "tools", "everything"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const scope = (url.searchParams.get("scope") ?? "os") as DeleteScope;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (!SCOPES.includes(scope)) {
    return NextResponse.json({ error: `scope must be one of ${SCOPES.join(", ")}` }, { status: 400 });
  }
  try {
    return NextResponse.json(await planDelete(id, scope));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read the client" },
      { status: 404 },
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  const { id, scope = "os", confirm, acceptDataLoss } = (body ?? {}) as Record<string, unknown>;

  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (!SCOPES.includes(scope as DeleteScope)) {
    return NextResponse.json({ error: `scope must be one of ${SCOPES.join(", ")}` }, { status: 400 });
  }
  if (typeof confirm !== "string" || !confirm.trim()) {
    return NextResponse.json({ error: "confirm is required" }, { status: 400 });
  }

  try {
    const result = await deleteClient(id, {
      scope: scope as DeleteScope,
      confirm,
      // Only ever true when the caller ticked the acknowledgement; anything
      // else (missing, "false", 0) stays false and the gate holds.
      acceptDataLoss: acceptDataLoss === true,
    });
    return NextResponse.json(result, { status: result.failed.length ? 502 : 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not delete the client" },
      { status: 400 },
    );
  }
}
