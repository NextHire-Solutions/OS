import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { readSession } from "@/lib/portal-login/login";
import { PORTAL_COOKIE } from "@/lib/portal-login/http";

import { SignInShell } from "../shell";
import { SignOut } from "../forms";

export const metadata: Metadata = { title: "Signed in — BrokerStaffer", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/*
 * Signed in. Until the new portal launches for clients, this is where a
 * sign-in lands: who they are and which portals they can open.
 */
export default async function DonePage() {
  const db = createAdminSupabase();
  const viewer = await readSession(db, (await cookies()).get(PORTAL_COOKIE)?.value, new Date());
  if (!viewer) redirect("/portal-signin");
  const { data } = await db.from("clients").select("id, name").in("id", viewer.portals);
  const names = ((data ?? []) as Array<{ name: string | null }>).map((c) => c.name ?? "Your portal");
  return (
    <SignInShell>
      <h1>You&apos;re signed in</h1>
      <p>Signed in as <b>{viewer.email}</b>.</p>
      <ul className="psi-list">{names.map((n) => <li key={n}>{n}</li>)}</ul>
      <p className="psi-small">Your new portal opens here when it launches. <SignOut /></p>
    </SignInShell>
  );
}
