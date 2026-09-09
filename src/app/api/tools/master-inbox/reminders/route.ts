import { NextResponse } from "next/server";

import { getReminders } from "@/lib/tools/master-inbox/reminders";

/*
 * Pending reminders.
 *
 * Read-only, and deliberately so: in the live tool, LOADING its reminders page
 * fires every due reminder and reopens the threads they point at. That is a
 * write, and the workspace does not do it yet — see reminders.ts.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getReminders());
}
