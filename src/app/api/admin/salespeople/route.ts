import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { getMasterClientList } from "@/lib/clients/master-list";
import { isAdmin } from "@/lib/identity/admin";
import { addSalesperson, listSalespeople, SalespersonError, updateSalesperson } from "@/lib/identity/salespeople";

/*
 * Team access → Salespeople. Admins only.
 *
 *   GET    the whole list, with emails and rates
 *   POST   { name, email? }                               add someone
 *   PATCH  { id, name?, email?, active?, residualRate? }  change someone;
 *          a rename is carried to every client that names them
 */
export const dynamic = "force-dynamic";

async function admin(request: Request): Promise<{ email: string } | NextResponse> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!session?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session.email)) return NextResponse.json({ error: "Only workspace admins can change the Salespeople list." }, { status: 403 });
  return { email: session.email.toLowerCase() };
}

const fail = (e: unknown) =>
  e instanceof SalespersonError
    ? NextResponse.json({ error: e.message }, { status: 400 })
    : NextResponse.json({ error: e instanceof Error ? e.message : "Could not save" }, { status: 502 });

export async function GET(request: Request) {
  const me = await admin(request);
  if (me instanceof NextResponse) return me;
  try {
    const { available, people } = await listSalespeople();
    // How many clients name each person — shown beside them.
    const list = await getMasterClientList().catch(() => null);
    const count = (name: string) =>
      list ? list.clients.filter((c) => (c.salesperson ?? "").trim().toLowerCase() === name.toLowerCase()).length : null;
    return NextResponse.json({ available, people: people.map((p) => ({ ...p, clients: count(p.name) })) });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request: Request) {
  const me = await admin(request);
  if (me instanceof NextResponse) return me;
  const body = (await request.json().catch(() => null)) as { name?: unknown; email?: unknown } | null;
  if (!body || typeof body.name !== "string") return NextResponse.json({ error: "A name is required." }, { status: 400 });
  try {
    const person = await addSalesperson({ name: body.name, email: typeof body.email === "string" ? body.email : null }, me.email);
    return NextResponse.json({ ok: true, person });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(request: Request) {
  const me = await admin(request);
  if (me instanceof NextResponse) return me;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.id !== "string") return NextResponse.json({ error: "id is required." }, { status: 400 });
  try {
    const result = await updateSalesperson(body.id, {
      name: typeof body.name === "string" ? body.name : undefined,
      email: body.email === null ? null : typeof body.email === "string" ? body.email : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
      residualRate: typeof body.residualRate === "number" ? body.residualRate : undefined,
    }, me.email);
    if (result.clientsRenamed) getMasterClientList.invalidate();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return fail(e);
  }
}
