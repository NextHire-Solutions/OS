import type { Metadata } from "next";

import { turnstileSiteKey } from "@/lib/portal-login/turnstile";

import { SignInShell } from "./shell";
import { EmailForm } from "./forms";

export const metadata: Metadata = { title: "Sign in — BrokerStaffer", robots: { index: false, follow: false } };
// The bot check's site key is read when the page is served (Railway's settings), never baked in at build.
export const dynamic = "force-dynamic";

/* Step 1: the client's email and "Send link to log in" (21 Oct). */
export default function SignInPage() {
  return (
    <SignInShell>
      <h1>Sign in to your portal</h1>
      <p>Enter your work email. If it can sign in, we&apos;ll email you a link — no password needed.</p>
      <EmailForm siteKey={turnstileSiteKey()} />
    </SignInShell>
  );
}
