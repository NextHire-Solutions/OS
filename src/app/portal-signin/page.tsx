import type { Metadata } from "next";

import { SignInShell } from "./shell";
import { EmailForm } from "./forms";

export const metadata: Metadata = { title: "Sign in — BrokerStaffer", robots: { index: false, follow: false } };

/* Step 1: the client's email and "Send link to log in" (21 Oct). */
export default function SignInPage() {
  return (
    <SignInShell>
      <h1>Sign in to your portal</h1>
      <p>Enter your work email. If it can sign in, we&apos;ll email you a link — no password needed.</p>
      <EmailForm />
    </SignInShell>
  );
}
