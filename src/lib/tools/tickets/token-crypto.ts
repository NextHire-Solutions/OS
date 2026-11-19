import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/*
 * TICKETS — the connected mailbox's Google refresh token, encrypted at rest (20 Nov).
 *
 * A refresh token reads a whole mailbox, so the database never holds it in plain text (the Onboarding app's
 * orch_email_account does; we don't copy that). AES-256-GCM with a key derived (HKDF-SHA256) from a secret that lives
 * only in the OS's environment: OS_TICKETS_TOKEN_KEY when set, else AUTH_SECRET (already on Railway, so nothing new to
 * configure). A copy of the database alone opens nothing.
 *
 * Format: "v1." + base64url(iv[12] | tag[16] | ciphertext). Changing the key secret makes old tokens undecryptable —
 * the mailbox then shows Reconnect, which is the right failure.
 */

const VERSION = "v1.";

function key(secret = process.env.OS_TICKETS_TOKEN_KEY || process.env.AUTH_SECRET || ""): Buffer {
  if (secret.length < 16) throw new Error("Tickets: no key to encrypt Gmail tokens with (OS_TICKETS_TOKEN_KEY or AUTH_SECRET)");
  return Buffer.from(hkdfSync("sha256", secret, "os-tickets", "gmail-refresh-token-v1", 32));
}

export function sealToken(plain: string, secret?: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return VERSION + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

/** The token, or null when it can't be opened (other key, damaged, not ours). Never throws. */
export function openToken(sealed: string | null | undefined, secret?: string): string | null {
  if (!sealed || !sealed.startsWith(VERSION)) return null;
  try {
    const raw = Buffer.from(sealed.slice(VERSION.length), "base64url");
    if (raw.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", key(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
