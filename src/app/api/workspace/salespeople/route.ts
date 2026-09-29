import { NextResponse } from "next/server";

import { listSalespeople } from "@/lib/identity/salespeople";

/*
 * The people who can be a client's Salesperson: the active names on Team
 * access → Salespeople. Names only — emails and rates stay on the admin
 * screen. The proxy has already verified the session.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { available, people } = await listSalespeople();
    return NextResponse.json({
      available,
      people: people.filter((p) => p.active).map((p) => ({ name: p.name })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read the Salespeople list" }, { status: 502 });
  }
}
