import { NextResponse } from "next/server";

import { osTable } from "@/lib/clients/os-db";
import { readClientPeople } from "@/lib/clients/people";

/*
 * One client's team, agents and DNC list — §23's "open one system and know
 * ... their assigned team, their agents".
 *
 * Per client rather than on the roster, deliberately. Answering it for all 52
 * clients at once would mean counting across 11,305 agent rows and 14,484 DNC
 * rows on every page load; answering it for the client somebody just opened is
 * three head requests per portal.
 *
 * Read-only. Master Inbox owns these lists and the portal reads them directly,
 * so the OS shows them and links out rather than writing them.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { data, error } = await osTable("os_clients")
    .select("id, name, aliases")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: `Could not read the client: ${error.message}` }, { status: 502 });
  }
  if (!data) return NextResponse.json({ error: "No such client" }, { status: 404 });

  const row = data as unknown as { id: string; name: string; aliases: string[] | null };
  const people = await readClientPeople({ name: row.name, aliases: row.aliases });

  /*
   * An unreadable Master Inbox answers 502 rather than zeroes. A count that is
   * silently zero because a database was down is worse than no count: it reads
   * as "this client has no agents", which is a statement about the client.
   */
  if (people.error) {
    return NextResponse.json({ error: people.error }, { status: 502 });
  }

  return NextResponse.json({ client: { id: row.id, name: row.name }, ...people });
}
