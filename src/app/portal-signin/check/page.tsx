import type { Metadata } from "next";

import { SignInShell } from "../shell";
import { CodeForm } from "../forms";

export const metadata: Metadata = { title: "Check your email — BrokerStaffer", robots: { index: false, follow: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;

/* Step 2: the same words whether or not the address can sign in — and the code, as a backup to the link. */
export default async function CheckPage({ searchParams }: { searchParams: Search }) {
  const raw = (await searchParams).e;
  const email = (Array.isArray(raw) ? raw[0] : raw ?? "").slice(0, 254);
  return (
    <SignInShell>
      <h1>Check your email</h1>
      <p>
        If <b>{email || "your address"}</b> can sign in, we&apos;ve sent it a sign-in link. It works once, for the next 15&nbsp;minutes.
      </p>
      {email ? <CodeForm email={email} /> : null}
      <p className="psi-small">Nothing arrived? Check spam, or <a href="/portal-signin">ask for a new link</a>. Only addresses BrokerStaffer has set up for your portal can sign in.</p>
    </SignInShell>
  );
}
