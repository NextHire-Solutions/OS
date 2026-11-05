import { NextResponse } from "next/server";

import { readSsoCookie, verifySso } from "@/lib/bs-auth";
import { getsLeadCapAlerts } from "@/lib/clients/billing-access";
import { osTable } from "@/lib/clients/os-db";
import { LEAD_CAP_BELL_KINDS } from "@/lib/clients/usage-billing/caps-model";
import { isAdminUser } from "@/lib/identity/admin-db";
import { runBillingWatch } from "@/lib/clients/billing-watch";

/*
 * The OS's notifications (the bell) — failed payments and portal blocks
 * (client feedback, 6 Oct). Admins only: it is money. The people named in
 * billing-access.ts get the lead cap's alerts and nothing else (5 Nov).
 *
 *   GET            the latest 50 they may see, each with `unread` for the person asking
 *   POST { ids? }  mark read for the person asking (all when ids is omitted), of those they may see
 *
 * A GET also runs the billing watch at most every five minutes, so the bell
 * is current even between the scheduler's passes.
 */
export const dynamic = "force-dynamic";

const slot = globalThis as unknown as { __osBillingWatchAt?: number };

async function who(request: Request): Promise<{ me: string; capsOnly: boolean } | NextResponse> {
  const s = await verifySso(process.env.AUTH_SECRET ?? "", readSsoCookie(request.headers.get("cookie")));
  if (!s?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = s.email.toLowerCase();
  if (await isAdminUser(s.email)) return { me, capsOnly: false };
  if (getsLeadCapAlerts(me)) return { me, capsOnly: true };
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function GET(request: Request) {
  const person = await who(request);
  if (person instanceof NextResponse) return person;
  const { me, capsOnly } = person;
  if (!capsOnly && Date.now() - (slot.__osBillingWatchAt ?? 0) > 5 * 60_000) {
    slot.__osBillingWatchAt = Date.now();
    void runBillingWatch().catch((e) => console.error("[notifications] billing watch", e));
  }
  let list = osTable("os_notifications").select("id, kind, severity, title, body, os_client_id, read_by, created_at");
  if (capsOnly) list = list.in("kind", [...LEAD_CAP_BELL_KINDS]);
  const { data, error } = await list.order("created_at", { ascending: false }).limit(50);
  if (error) return NextResponse.json({ ready: false, items: [], unread: 0, note: "Needs migrations/0030_billing_profile.sql run first." });
  const items = ((data ?? []) as Array<Record<string, unknown>>).map((n) => ({
    id: String(n.id), kind: String(n.kind), severity: String(n.severity), title: String(n.title), body: (n.body as string | null) ?? null,
    clientId: (n.os_client_id as string | null) ?? null, createdAt: String(n.created_at),
    unread: !((n.read_by as string[] | null) ?? []).includes(me),
  }));
  return NextResponse.json({ ready: true, capsOnly, items, unread: items.filter((i) => i.unread).length });
}

export async function POST(request: Request) {
  const person = await who(request);
  if (person instanceof NextResponse) return person;
  const { me, capsOnly } = person;
  const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? (body!.ids as unknown[]).filter((x): x is string => typeof x === "string") : null;
  let q = osTable("os_notifications").select("id, read_by").order("created_at", { ascending: false }).limit(200);
  if (capsOnly) q = q.in("kind", [...LEAD_CAP_BELL_KINDS]);
  if (ids) q = q.in("id", ids);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  for (const n of (data ?? []) as Array<{ id: string; read_by: string[] | null }>) {
    const read = n.read_by ?? [];
    if (!read.includes(me)) await osTable("os_notifications").update({ read_by: [...read, me] }).eq("id", n.id);
  }
  return NextResponse.json({ ok: true });
}
