import { NextResponse } from "next/server";

import { CoverageError, getCoverage, listCoverage, setCoverage } from "@/lib/clients/coverage-db";
import { getMasterClientList } from "@/lib/clients/master-list";
import { deriveCodesFromList } from "@/lib/clients/markets-mls";
import { syncDatabaseMls } from "@/lib/clients/markets-mls-sync";
import { getCorofySupabase } from "@/lib/tools/corofy/supabase";

/*
 * A client's Markets, MLS and Area — the three the client data sheet records
 * (migration 0022): how many markets, which MLS boards, which areas. Three
 * independent facts, not paired rows (the client, 30 Sep).
 *
 *   GET  ?clientId=…                              the three, plus board and area suggestions
 *   PUT  { clientId, markets?, mls?, areas? }     change any of them
 *
 * After a change to MLS, the Database row's codes are rewritten from it
 * (markets-mls-sync.ts). Never fatal — the save stands either way — but
 * reported, so a code the lead builder cannot use shows where it was typed.
 */
export const dynamic = "force-dynamic";

/** Every MLS board in the Database, for the MLS field. Empty on failure — the form still works. */
async function mlsBoards(): Promise<{ code: string; label: string }[]> {
  try {
    const { data, error } = await getCorofySupabase().from("mls").select("code, name, state").order("code").limit(500);
    if (error) return [];
    return ((data ?? []) as { code: string | null; name: string | null; state: string | null }[])
      .filter((b) => b.code?.trim())
      .map((b) => ({ code: b.code!.trim(), label: [b.name, b.state].filter(Boolean).join(" · ") }));
  } catch {
    return [];
  }
}

const fail = (e: unknown) =>
  e instanceof CoverageError
    ? NextResponse.json({ error: e.message }, { status: e.status })
    : NextResponse.json({ error: e instanceof Error ? e.message : "Could not read markets" }, { status: 502 });

export async function GET(request: Request) {
  const clientId = new URL(request.url).searchParams.get("clientId");
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  try {
    const [coverage, boards, all] = await Promise.all([getCoverage(clientId), mlsBoards(), listCoverage()]);
    // Areas already in use anywhere, so the same place is spelled one way.
    const areas = [...new Set([...(all?.values() ?? [])].flatMap((c) => c.areas))].sort((a, b) => a.localeCompare(b));
    const lead = deriveCodesFromList(coverage.mls, boards.map((b) => ({ code: b.code, name: null, state: null })));
    return NextResponse.json({ coverage, boards, suggestions: { areas }, leadBuilding: { codes: lead.codes, unknown: lead.unknown } });
  } catch (e) {
    return fail(e);
  }
}

export async function PUT(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 }); }
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  try {
    const coverage = await setCoverage(clientId, { markets: body.markets, mls: body.mls, areas: body.areas });
    getMasterClientList.invalidate();
    let leadBuilding: unknown = null;
    if (body.mls !== undefined) {
      try {
        const r = await syncDatabaseMls(clientId);
        leadBuilding = { codes: r.codes, unknown: r.unknown, linked: r.linked };
      } catch (e) {
        leadBuilding = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    return NextResponse.json({ coverage, leadBuilding });
  } catch (e) {
    return fail(e);
  }
}
