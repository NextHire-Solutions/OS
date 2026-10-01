import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { editClient, InvalidEditError } from "@/lib/clients/edit";
import { getMasterClientList } from "@/lib/clients/master-list";
import { osTable } from "@/lib/clients/os-db";
import { loadCommissions } from "@/lib/commissions/load";
import { isAdminUser } from "@/lib/identity/admin-db";
import { SALESPERSON_RATES } from "@/lib/commissions/schedule";
import { SalespersonError, updateSalesperson } from "@/lib/identity/salespeople";

/*
 * Commissions.
 *
 *   GET   ?as=<earner key|all>&run=YYYY-MM-DD
 *         The viewer's own payouts — as a salesperson, an account manager, or
 *         both. Admins may view anyone ("sp:<id>" / "am:<email>") or
 *         everyone; everyone else sees only their own, whatever `as` says —
 *         the scoping is in loadCommissions, from the SIGNED session, never
 *         from the request.
 *
 *   POST  admin only
 *         { kind: "assign", clientId, salesperson?, accountManager?, monthlyGross? }
 *           salesperson / accountManager go through the master record's own
 *           edit (role holders only); monthlyGross is the stand-in for a
 *           client with no Stripe link (null removes it).
 *         { kind: "rates", key: "sp:<id>", rate: 0.2 | 0.1 }  a salesperson's rate
 *           (account managers are always 5%)
 */
export const dynamic = "force-dynamic";

async function who(request: Request): Promise<{ email: string; admin: boolean } | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!session?.email) return null;
  return { email: session.email.toLowerCase(), admin: await isAdminUser(session.email) };
}

export async function GET(request: Request) {
  const me = await who(request);
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  try {
    return NextResponse.json(await loadCommissions({
      viewerEmail: me.email, admin: me.admin,
      as: me.admin ? url.searchParams.get("as") : null,
      run: url.searchParams.get("run"),
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load commissions" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const me = await who(request);
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!me.admin) return NextResponse.json({ error: "Only admins can assign clients or change rates." }, { status: 403 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  const now = new Date().toISOString();

  try {
    if (body.kind === "assign") {
      const clientId = typeof body.clientId === "string" ? body.clientId : "";
      if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
      const done: string[] = [];
      // The master record's own edit: role holders only, synced to every tool.
      const people: { salesperson?: string | null; accountManager?: string | null } = {};
      if (body.salesperson !== undefined) people.salesperson = typeof body.salesperson === "string" && body.salesperson.trim() ? body.salesperson.trim() : null;
      if (body.accountManager !== undefined) people.accountManager = typeof body.accountManager === "string" && body.accountManager.trim() ? body.accountManager.trim() : null;
      if (Object.keys(people).length) {
        await editClient(clientId, people);
        if ("salesperson" in people) done.push("salesperson");
        if ("accountManager" in people) done.push("account manager");
      }
      if (body.monthlyGross !== undefined) {
        const g = body.monthlyGross;
        if (g === null || g === "") {
          const { error } = await osTable("os_client_commission").delete().eq("client_id", clientId);
          if (error) throw new Error(migrationHint(error.message));
        } else {
          const n = typeof g === "number" ? g : Number(g);
          if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
            return NextResponse.json({ error: "Monthly gross must be a dollar amount of 0 or more." }, { status: 400 });
          }
          const { error } = await osTable("os_client_commission")
            .upsert({ client_id: clientId, monthly_gross: Math.round(n * 100) / 100, updated_at: now, updated_by: me.email });
          if (error) throw new Error(migrationHint(error.message));
        }
        done.push("monthly gross");
      }
      getMasterClientList.invalidate();
      return NextResponse.json({ ok: true, updated: done });
    }

    if (body.kind === "rates") {
      const key = typeof body.key === "string" ? body.key : "";
      const rate = Number(body.rate);
      if (!key.startsWith("sp:")) {
        return NextResponse.json({ error: "Only a salesperson's rate can be changed; account managers earn 5%." }, { status: 400 });
      }
      if (!SALESPERSON_RATES.includes(rate)) return NextResponse.json({ error: "A salesperson's rate is 20% or 10%." }, { status: 400 });
      // A salesperson's rate lives on their record.
      await updateSalesperson(key.slice(3), { rate }, me.email);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    if (error instanceof InvalidEditError || error instanceof SalespersonError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save" }, { status: 502 });
  }
}

function migrationHint(message: string): string {
  return /does not exist|schema cache|relation/i.test(message)
    ? "Commission settings are not set up yet — run migrations/0019_commissions.sql in Supabase."
    : message;
}
