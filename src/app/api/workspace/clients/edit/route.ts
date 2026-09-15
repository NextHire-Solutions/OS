import { NextResponse } from "next/server";

import { editClient, validateEdit, type ClientEdit } from "@/lib/clients/edit";

/*
 * Edit a client.
 *
 * Writes to `os_clients` always, and outward to Analytics (aliases) and Client
 * Health (plan, targets, billing) when those fields change. Master Inbox is
 * never written — see lib/clients/edit.ts for why, and the response says so
 * rather than silently doing nothing.
 *
 * Returns 200 with `failed` populated when SOME legs worked: a partial edit is
 * a real outcome across three databases, and collapsing it into a 500 would
 * hide which half landed.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const { id, ...edit } = (body ?? {}) as Record<string, unknown>;
  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const errors = validateEdit(edit as ClientEdit);
  if (errors.length) return NextResponse.json({ error: errors.join(" ") }, { status: 400 });

  try {
    const result = await editClient(id, edit as ClientEdit);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not edit the client" },
      { status: 502 },
    );
  }
}
