import { NextResponse } from "next/server";

import { getMasterClientList } from "@/lib/clients/master-list";
import { stripeSummaries } from "@/lib/clients/stripe-summary";

/*
 * Total spend, MRR and Stripe's customer-created day for every client linked
 * to Stripe (Eddy, 1 Oct). Separate from the client list so a slow Stripe
 * never holds the list up: the Clients screen asks for this after it loads.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { clients } = await getMasterClientList();
    return NextResponse.json(await stripeSummaries(clients));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read Stripe" }, { status: 502 });
  }
}
