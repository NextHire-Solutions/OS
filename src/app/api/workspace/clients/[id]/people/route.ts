import { NextResponse } from "next/server";

import { osTable } from "@/lib/clients/os-db";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { portalsFor, readClientPeople, type MiPortalRow } from "@/lib/clients/people";
import {
  addPortalPerson,
  isPeopleResource,
  removePortalPerson,
  type AddPersonInput,
} from "@/lib/clients/portal-people-write";

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

/*
 * Editing those lists from the OS — the other half of §21 step 6.
 *
 * Both sides write THE SAME ROWS, so "two-way" needs no sync job: the OS calls
 * the client's own portal API, which is the only thing that enforces the
 * Instantly and EmailBison blocklists before writing. See
 * lib/clients/portal-people-write.ts for why a direct insert would be worse
 * than no feature at all.
 *
 * ---------------------------------------------------------------------------
 * THE PORTAL MUST BELONG TO THIS CLIENT
 *
 * A portal token is a credential, and the caller names the portal. So the
 * portal is resolved from the CLIENT's own name and aliases and the requested
 * one must be in that set — a caller cannot hand us an id and have us write to
 * somebody else's portal with their token.
 */
async function portalOf(
  clientId: string,
  portalId: string,
): Promise<
  | { ok: true; token: string; name: string }
  | { ok: false; status: number; error: string }
> {
  const { data, error } = await osTable("os_clients")
    .select("id, name, aliases")
    .eq("id", clientId)
    .maybeSingle();
  if (error) return { ok: false, status: 502, error: `Could not read the client: ${error.message}` };
  if (!data) return { ok: false, status: 404, error: "No such client" };
  const client = data as unknown as { name: string; aliases: string[] | null };

  const db = getMasterInboxSupabase();
  const { data: rows, error: miError } = await db
    .from("clients")
    .select("id, name, portal_enabled, portal_token")
    .limit(1000);
  if (miError) return { ok: false, status: 502, error: miError.message };

  const mine = portalsFor(client, (rows ?? []) as unknown as MiPortalRow[]);
  const match = mine.find((p) => p.id === portalId);
  if (!match) {
    return {
      ok: false,
      status: 400,
      error: `That portal does not belong to ${client.name}. Its portals are: ${
        mine.map((p) => p.name).join(", ") || "none"
      }.`,
    };
  }
  const token = (rows ?? []).find((r) => (r as { id: string }).id === portalId) as
    | { portal_token?: string | null }
    | undefined;
  if (!token?.portal_token) {
    return { ok: false, status: 409, error: `"${match.name}" has no portal token, so it cannot be edited.` };
  }
  return { ok: true, token: token.portal_token, name: match.name };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as
    | ({ portalId?: string; resource?: string } & AddPersonInput)
    | null;
  if (!body) return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });

  const resource = String(body.resource ?? "");
  if (!isPeopleResource(resource)) {
    return NextResponse.json({ error: "resource must be team, agents or dnc" }, { status: 400 });
  }
  const portalId = String(body.portalId ?? "");
  if (!portalId) return NextResponse.json({ error: "portalId is required" }, { status: 400 });

  const portal = await portalOf(id, portalId);
  if (!portal.ok) return NextResponse.json({ error: portal.error }, { status: portal.status });

  const result = await addPortalPerson(portal.token, resource, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, portal: portal.name }, { status: result.status || 502 });
  }
  return NextResponse.json({ ok: true, portal: portal.name, resource, created: result.body });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const portalId = url.searchParams.get("portalId") ?? "";
  const resource = url.searchParams.get("resource") ?? "";
  const personId = url.searchParams.get("personId") ?? "";

  if (!isPeopleResource(resource)) {
    return NextResponse.json({ error: "resource must be team, agents or dnc" }, { status: 400 });
  }
  if (!portalId || !personId) {
    return NextResponse.json({ error: "portalId and personId are required" }, { status: 400 });
  }

  const portal = await portalOf(id, portalId);
  if (!portal.ok) return NextResponse.json({ error: portal.error }, { status: portal.status });

  const result = await removePortalPerson(portal.token, resource, personId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, portal: portal.name }, { status: result.status || 502 });
  }
  return NextResponse.json({
    ok: true,
    portal: portal.name,
    resource,
    /*
     * Said plainly rather than left for someone to discover: taking a row off
     * the do-not-contact list does NOT un-block the address on Instantly or
     * EmailBison. Suppression there is one-way.
     */
    ...(resource === "dnc"
      ? {
          note:
            "Removed from this client's do-not-contact list. The address stays suppressed on " +
            "Instantly and EmailBison — clear it there too if that is the intention.",
        }
      : {}),
  });
}
