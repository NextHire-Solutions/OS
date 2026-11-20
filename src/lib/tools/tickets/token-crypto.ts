import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/*
 * TICKETS — the connected mailbox's Google refresh token, encrypted at rest (20 Nov).
 *
 * A refresh token reads a whole mailbox, so the database never holds it in plain text (the Onboarding app's
 * orch_email_account does; we don't copy that). AES-256-GCM with a key derived (HKDF-SHA256) from OS_TICKETS_TOKEN_KEY,
 * which lives only in the OS's environment — its own secret, not the sign-in one (review, 20 Nov: rotating AUTH_SECRET
 * must not silently disconnect every inbox). Each token is bound to its mailbox's address (additional authenticated
 * data): a token copied onto another mailbox's row opens nothing. A copy of the database alone opens nothing.
 *
 * Format: "v1." + base64url(iv[12] | tag[16] | ciphertext). A changed key makes old tokens undecryptable — the
 * mailbox then shows Reconnect, which is the right failure.
 */

const VERSION = "v1.";

function key(secret = process.env.OS_TICKETS_TOKEN_KEY || ""): Buffer {
  if (secret.length < 32) throw new Error("Tickets: OS_TICKETS_TOKEN_KEY (32+ characters) is not set, so Gmail tokens can't be stored");
  return Buffer.from(hkdfSync("sha256", secret, "os-tickets", "gmail-refresh-token-v1", 32));
}

const aad = (mailbox: string) => Buffer.from(`os-tickets:${mailbox.trim().toLowerCase()}`, "utf8");

export function sealToken(plain: string, mailbox: string, secret?: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  c.setAAD(aad(mailbox));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return VERSION + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

/** The token, or null when it can't be opened (other key, other mailbox, damaged, not ours). Never throws. */
export function openToken(sealed: string | null | undefined, mailbox: string, secret?: string): string | null {
  if (!sealed || !sealed.startsWith(VERSION)) return null;
  try {
    const raw = Buffer.from(sealed.slice(VERSION.length), "base64url");
    if (raw.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", key(secret), raw.subarray(0, 12));
    d.setAAD(aad(mailbox));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
