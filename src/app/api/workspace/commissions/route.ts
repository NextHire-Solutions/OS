import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { editClient, InvalidEditError } from "@/lib/clients/edit";
import { getMasterClientList } from "@/lib/clients/master-list";
import { osTable } from "@/lib/clients/os-db";
import { loadCommissions } from "@/lib/commissions/load";
import { isAdmin } from "@/lib/identity/admin";
import { listTeamMembers } from "@/lib/identity/team-directory";

/*
 * Commissions.
 *
 *   GET   ?as=<email|all>&run=YYYY-MM-DD
 *         The viewer's own payouts. Admins may view any account manager, or
 *         all of them; everyone else is scoped to themselves no matter what
 *         `as` says — the scoping is in loadCommissions, from the SIGNED
 *         session, never from the request.
 *
 *   POST  admin only
 *         { kind: "assign", clientId, accountManager?, monthlyGross? }
 *           accountManager goes through the master record's own edit
 *           (Team access members only); monthlyGross is the stand-in for a
 *           client with no Stripe link (null removes it).
 *         { kind: "rates", email, residualRate, monthOneRate? }
 */
export const dynamic = "force-dynamic";

async function who(request: Request): Promise<{ email: string; admin: boolean } | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const session = await verifySso(secret, readSsoCookie(request.headers.get("cookie")));
  if (!session?.email) return null;
  return { email: session.email.toLowerCase(), admin: isAdmin(session.email) };
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

const RESIDUAL_OK = [0.15, 0.25];

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
      if (body.accountManager !== undefined) {
        const am = typeof body.accountManager === "string" ? body.accountManager : "";
        // The master record's own edit: Team access members only, synced to every tool.
        await editClient(clientId, { accountManager: am.trim() || null });
        done.push("account manager");
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
      const email = typeof body.email === "string" ? body.email.toLowerCase() : "";
      const residual = Number(body.residualRate);
      const monthOne = body.monthOneRate === undefined ? 0.7 : Number(body.monthOneRate);
      if (!(await listTeamMembers()).some((m) => m.email === email)) {
        return NextResponse.json({ error: "That person is not on Team access." }, { status: 400 });
      }
      if (!RESIDUAL_OK.includes(residual)) return NextResponse.json({ error: "The residual rate is 15% or 25%." }, { status: 400 });
      if (!Number.isFinite(monthOne) || monthOne < 0 || monthOne > 1) return NextResponse.json({ error: "The month-one rate must be between 0% and 100%." }, { status: 400 });
      const { error } = await osTable("os_commission_reps")
        .upsert({ email, residual_rate: residual, month_one_rate: monthOne, updated_at: now, updated_by: me.email });
      if (error) throw new Error(migrationHint(error.message));
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    if (error instanceof InvalidEditError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save" }, { status: 502 });
  }
}

function migrationHint(message: string): string {
  return /does not exist|schema cache|relation/i.test(message)
    ? "Commission settings are not set up yet — run migrations/0019_commissions.sql in Supabase."
    : message;
}
