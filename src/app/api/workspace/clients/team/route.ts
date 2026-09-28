import { NextResponse } from "next/server";

import { getOnboardingDb } from "@/lib/tools/onboarding/db";

/*
 * The team list (Onboarding → Settings → People), as suggestions for the Edit
 * dialog's Salesperson and Account Manager fields. Names only — nothing else
 * about a person leaves this route. Active people only; a name typed that is
 * not on the list is still accepted and added (people-link.ts).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const { data, error } = await getOnboardingDb()
    .from("orch_salespeople")
    .select("name, role")
    .eq("active", true)
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  const rows = (data ?? []) as { name: string; role: string | null }[];
  const names = (role: string) => [...new Set(rows.filter((r) => r.role === role).map((r) => r.name.trim()).filter(Boolean))];
  return NextResponse.json({ salespeople: names("salesperson"), accountManagers: names("account_manager") });
}
