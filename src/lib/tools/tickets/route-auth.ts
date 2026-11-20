import "server-only";

import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { isAdminUser } from "@/lib/identity/admin-db";

import { TicketActionError } from "./service";

/*
 * TICKETS — every API route's first line. The proxy already refuses anyone without the Tickets switch
 * (tool-paths.ts: /api/tools/tickets → `tickets`); this repeats it so a route can never be reached around the proxy.
 */

export interface TicketsViewer { email: string; admin: boolean }

export async function ticketsViewer(request: Request): Promise<TicketsViewer | NextResponse> {
  const s = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!s) return NextResponse.json({ error: "Sign in again" }, { status: 401 });
  const admin = await isAdminUser(s.email).catch(() => false);
  if (!admin && !s.grants.includes("tickets")) return NextResponse.json({ error: "Tickets isn't switched on for you" }, { status: 403 });
  return { email: s.email.toLowerCase(), admin };
}

/** A thrown error as the screen should see it. */
export function failure(e: unknown): NextResponse {
  if (e instanceof TicketActionError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[tickets]", e instanceof Error ? e.message : e);
  return NextResponse.json({ error: "Something went wrong reading Tickets. Try again in a moment." }, { status: 500 });
}

/** A same-site write: the OS's own pages send JSON with the Origin of the OS. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
  } catch {
    return false;
  }
}
