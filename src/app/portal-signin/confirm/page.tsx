import type { Metadata } from "next";

import { SignInShell } from "../shell";
import { ConfirmButton } from "../forms";

export const metadata: Metadata = { title: "Sign in — BrokerStaffer", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Search = Promise<Record<string, string | string[] | undefined>>;

/*
 * The email's link opens this page; the person presses Sign in. Opening the
 * link alone signs nobody in — mail scanners open links by themselves.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Search }) {
  const raw = (await searchParams).t;
  const t = (Array.isArray(raw) ? raw[0] : raw ?? "").slice(0, 200);
  return (
    <SignInShell>
      <h1>Sign in to BrokerStaffer</h1>
      {t ? (
        <>
          <p>Press Sign in to open your portal on this device.</p>
          <ConfirmButton t={t} />
        </>
      ) : (
        <p>This link is incomplete. <a href="/portal-signin">Ask for a new sign-in link</a>.</p>
      )}
    </SignInShell>
  );
}
