import { NextResponse } from "next/server";

import {
  addMarket,
  listAllMarkets,
  listMarkets,
  removeMarket,
  updateMarket,
  type MarketsResult,
} from "@/lib/clients/markets-db";
import { suggestionsFrom } from "@/lib/clients/markets";
import { deriveCodes } from "@/lib/clients/markets-mls";
import { syncDatabaseMls } from "@/lib/clients/markets-mls-sync";
import { getCorofySupabase } from "@/lib/tools/corofy/supabase";

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

/*
 * A client's markets: the (market, MLS, area) combinations they cover.
 *
 * A client may have many — that is the whole point of the table, and why this is
 * a collection endpoint rather than more fields on the client edit route.
 *
 *   GET    ?clientId=…            list them, plus the suggestions for the form
 *   POST   { clientId, market, mls?, area? }        add one
 *   PATCH  { clientId, id, market, mls?, area? }    edit one
 *   DELETE ?clientId=…&id=…                         remove one
 *
 * Every write is scoped by BOTH clientId and id, so an id belonging to another
 * client cannot be edited or deleted by guessing it. The validation lives in
 * lib/clients/markets.ts and runs against the client's current rows, so a
 * duplicate comes back as a sentence naming the row it clashes with rather than
 * a Postgres constraint string.
 *
 * Markets are deliberately NOT linked to a portal here — see migration 0017.
 */
export const dynamic = "force-dynamic";

/*
 * After every change, the Database row's MLS codes are rewritten from the
 * Markets (markets-mls.ts). Never fatal — the market is saved either way — but
 * reported, so a code the lead builder cannot use is visible where it was typed.
 */
async function leadBuilding(clientId: string) {
  try {
    const r = await syncDatabaseMls(clientId);
    return { codes: r.codes, unknown: r.unknown, linked: r.linked };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** One place that turns a MarketsResult into a response, so codes stay consistent. */
async function respondAndSync<T>(result: MarketsResult<T>, key: string, clientId: string) {
  if (result.ok) return NextResponse.json({ [key]: result.value, leadBuilding: await leadBuilding(clientId) });
  return respond(result, key);
}

function respond<T>(result: MarketsResult<T>, key: string) {
  if (result.ok) return NextResponse.json({ [key]: result.value });
  return NextResponse.json(
    { error: result.error, ...(result.field ? { field: result.field } : {}) },
    { status: result.status },
  );
}

function readBody(body: unknown) {
  const { clientId, id, market, mls, area } = (body ?? {}) as Record<string, unknown>;
  return {
    clientId: typeof clientId === "string" ? clientId : "",
    id: typeof id === "string" ? id : "",
    // Passed through as-is: `clean()` in markets.ts owns trimming and
    // blank-to-null, and doing any of it twice in two places is how they drift.
    input: {
      market: typeof market === "string" ? market : "",
      mls: typeof mls === "string" ? mls : null,
      area: typeof area === "string" ? area : null,
    },
  };
}

export async function GET(request: Request) {
  const clientId = new URL(request.url).searchParams.get("clientId");
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });

  const mine = await listMarkets(clientId);
  if (!mine.ok) return respond(mine, "markets");

  /*
   * The suggestions come from EVERY client's markets, not this client's.
   *
   * These are free-text fields (same decision as migration 0015's "names, not
   * foreign keys"), so the defence against "Boston" / "boston" / "Bostn" is
   * making the spelling already in use one click away. Suggesting only this
   * client's own markets would suggest exactly the rows they cannot add again.
   *
   * A failure here is not fatal: the form still works, it just has no datalist.
   */
  const [all, boards] = await Promise.all([listAllMarkets(), mlsBoards()]);
  return NextResponse.json({
    markets: mine.value,
    suggestions: all.ok
      ? suggestionsFrom(all.value)
      : { markets: [], mlses: [], areas: [] },
    /*
     * The MLS boards the Database knows, offered by CODE with the full name
     * and state as the label. A board typed freely is how "HAR" came to mean
     * a California board in one place and Houston in another (the Database
     * developer's finding, 28 Sep) — picking the code keeps one spelling per
     * board. Still free text: an area with no board listed can be entered.
     */
    boards,
    // What the lead builder will use, derived from these markets — shown under the list.
    leadBuilding: all.ok
      ? (() => { const d = deriveCodes(mine.value, boards.map((b) => ({ code: b.code, name: null, state: null }))); return { codes: d.codes, unknown: d.unknown }; })()
      : null,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  const { clientId, input } = readBody(body);
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  return respondAndSync(await addMarket(clientId, input), "market", clientId);
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  const { clientId, id, input } = readBody(body);
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  return respondAndSync(await updateMarket(clientId, id, input), "market", clientId);
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");
  const id = url.searchParams.get("id");
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  return respondAndSync(await removeMarket(clientId, id), "removed", clientId);
}
