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

/** One place that turns a MarketsResult into a response, so codes stay consistent. */
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
  const all = await listAllMarkets();
  return NextResponse.json({
    markets: mine.value,
    suggestions: all.ok
      ? suggestionsFrom(all.value)
      : { markets: [], mlses: [], areas: [] },
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
  return respond(await addMarket(clientId, input), "market");
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
  return respond(await updateMarket(clientId, id, input), "market");
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId");
  const id = url.searchParams.get("id");
  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  return respond(await removeMarket(clientId, id), "removed");
}
