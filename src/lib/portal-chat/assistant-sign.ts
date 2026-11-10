import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * What the assistant said, signed by the server that said it (9 Nov review). "Ask for a person" hands our team what was
 * said before they asked; the window sends that back, so a line it calls the assistant's is kept as the assistant's only
 * when it carries this signature — nobody can put words in the assistant's mouth for our team to read.
 */

type Env = Readonly<Record<string, string | undefined>>;
const SIG_CHARS = 32;
const SIG = /^[A-Za-z0-9_-]{32}$/;

export function signAssistant(portalId: string, text: string, env: Env = process.env): string | null {
  const secret = env.AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", `portal-assistant:${secret}`).update(`${portalId}\n${text}`).digest("base64url").slice(0, SIG_CHARS);
}

export function isAssistantsOwn(portalId: string, text: string, sig: unknown, env: Env = process.env): boolean {
  const want = signAssistant(portalId, text, env);
  // base64url characters only: a crafted one of the same length in other characters is a different byte length.
  if (!want || typeof sig !== "string" || !SIG.test(sig)) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}
