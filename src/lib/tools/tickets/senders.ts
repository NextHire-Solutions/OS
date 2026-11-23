/*
 * TICKETS — WHICH INBOXES CAN SEND (24 Nov 2026, the user): "It's only for Amy and Eddy email" and "anyone that has
 * access to Tickets page should be able to reply to emails as the one who got email. like Amy got the email but eddy
 * can reply to email as amy" (Gabriel too). So a reply goes out from the inbox the client wrote to, and only these
 * two inboxes ever send. Everyone else's connection stays read-only: they are never asked for, and never keep, Gmail's
 * send permission (gmail-api.ts consentUrl / the callback).
 *
 * No server imports: the screens read it too.
 */

export const TICKETS_SENDERS: readonly string[] = ["amy@brokerstaffer.com", "eddy@brokerstaffer.com"];

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

const norm = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

/** This inbox may send replies from Tickets. */
export function canSendFrom(email: string | null | undefined): boolean {
  return TICKETS_SENDERS.includes(norm(email));
}

/** The stored connection carries Gmail's send permission. */
export function scopeCanSend(scope: string | null | undefined): boolean {
  return String(scope ?? "").split(/\s+/).includes(GMAIL_SEND_SCOPE);
}
