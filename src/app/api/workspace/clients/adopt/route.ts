import { NextResponse } from "next/server";

import { osTable } from "@/lib/clients/os-db";
import { toSlug } from "@/lib/clients/slug";

/*
 * Create (or find) the OS record a run attaches its history to.
 *
 * Separate from the run itself because it must be idempotent: pressing the
 * button twice, or retrying after a failed leg, has to reach the SAME record,
 * or the second attempt would start a fresh history and happily re-run legs
 * that already succeeded.
 *
 * Writes only to `os_clients`. No tool is contacted — a record here means
 * "the OS knows about this client", not "this client exists anywhere".
 * `status` starts as `onboarding` for exactly that reason.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  const { name, aliases } = (body ?? {}) as { name?: unknown; aliases?: unknown };
  const clean = typeof name === "string" ? name.trim() : "";
  if (!clean) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const list = Array.isArray(aliases) ? aliases.map(String).map((a) => a.trim()).filter(Boolean) : [];

  try {
    const { data: found, error: findErr } = await osTable("os_clients")
      .select("id, name, status")
      .ilike("name", clean)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (found) {
      const row = found as unknown as { id: string; name: string; status: string };
      return NextResponse.json({ id: row.id, name: row.name, status: row.status, created: false });
    }

    const { data, error } = await osTable("os_clients")
      .insert({ name: clean, slug: toSlug(clean), aliases: list, status: "onboarding", source: "os" })
      .select("id, name, status")
      .single();
    if (error) throw new Error(error.message);
    const row = data as unknown as { id: string; name: string; status: string };
    return NextResponse.json({ id: row.id, name: row.name, status: row.status, created: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create the record" },
      { status: 502 },
    );
  }
}
