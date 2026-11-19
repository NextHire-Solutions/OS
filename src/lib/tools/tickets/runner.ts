import "server-only";

import { randomUUID } from "node:crypto";

import { osTable } from "@/lib/clients/os-db";

import { oauthConfig } from "./config";
import { clientDirectory, teamDirectory } from "./directory";
import { GmailAuthError, GmailClient, refreshAccessToken } from "./gmail-api";
import type { MailboxRow } from "./store";
import { dbTicketStore } from "./store-db";
import { syncMailbox, type SyncReport } from "./sync";
import { wake } from "./ticket-rules";
import { openToken } from "./token-crypto";

/*
 * TICKETS — the background run (instrumentation.ts, every minute on Railway): every connected mailbox in turn,
 * then any snooze that has ended. One run at a time per mailbox across replicas (a claim on its row; a first fill
 * can take minutes, so a claim only goes stale after 30). Never throws.
 *
 * A mailbox Google stops letting us read (password changed, access removed, 6 months unused) turns to
 * "reconnect": the Tickets screen asks its owner to connect again, and the bell tells the admins once a day.
 */

const CLAIM_STALE_MS = 30 * 60_000;

/** Access tokens live an hour; one per mailbox, shared by every run in this process. */
const tokens: Map<string, { accessToken: string; expiresAt: number }> =
  ((globalThis as Record<symbol, unknown>)[Symbol.for("os.tickets.accessTokens")] ??= new Map()) as Map<string, { accessToken: string; expiresAt: number }>;

export function gmailFor(mailbox: string, refreshToken: string): GmailClient {
  return new GmailClient(mailbox, async () => {
    const had = tokens.get(mailbox);
    if (had && had.expiresAt > Date.now()) return had;
    const cfg = oauthConfig();
    if (!cfg) throw new GmailAuthError("Google sign-in for Tickets isn't configured", false);
    const t = await refreshAccessToken(cfg, refreshToken);
    tokens.set(mailbox, t);
    return t;
  });
}

export function forgetAccessToken(mailbox: string) {
  tokens.delete(mailbox);
}

/** The Gmail client for a stored mailbox, or null when its token can't be opened. */
export function gmailForMailbox(mb: Pick<MailboxRow, "email" | "token_enc">): GmailClient | null {
  const refresh = openToken(mb.token_enc);
  return refresh ? gmailFor(mb.email, refresh) : null;
}

export interface RunResult {
  ready: boolean;
  mailboxes: number;
  synced: Array<{ email: string } & Partial<SyncReport> & { error?: string }>;
  woke: number;
}

const friendly = (e: GmailAuthError) =>
  /invalid_grant/i.test(e.message)
    ? "Google stopped this connection (password changed, access removed, or unused for months). Connect again."
    : /admin_policy/i.test(e.message)
      ? "Your Google Workspace admin blocked this app's access to Gmail."
      : `Google refused access: ${e.message.slice(0, 160)}`;

export async function runTicketsSync(): Promise<RunResult> {
  const out: RunResult = { ready: true, mailboxes: 0, synced: [], woke: 0 };
  let mailboxes: MailboxRow[];
  try {
    mailboxes = await dbTicketStore.listMailboxes();
  } catch {
    return { ...out, ready: false };
  }
  const live = mailboxes.filter((m) => m.token_enc && (m.state === "syncing" || m.state === "ok"));
  out.mailboxes = live.length;

  if (live.length && oauthConfig()) {
    let dir: Awaited<ReturnType<typeof clientDirectory>> | null = null;
    try { dir = await clientDirectory(); } catch (e) { console.error("[tickets] client list unreadable:", e instanceof Error ? e.message : e); }
    const team = await teamDirectory(mailboxes);
    for (const mb of dir ? live : []) {
      const token = randomUUID();
      try {
        if (!(await dbTicketStore.claimMailbox(mb.email, token, CLAIM_STALE_MS))) continue;
      } catch {
        continue;
      }
      const now = () => new Date().toISOString();
      try {
        const gmail = gmailForMailbox(mb);
        if (!gmail) throw new GmailAuthError("invalid_grant: the stored access can't be opened", true);
        const r = await syncMailbox({ store: dbTicketStore, gmail, index: dir!.index, team: team.set, names: team.names }, mb);
        await dbTicketStore.releaseMailbox(mb.email, token, {
          state: "ok", history_id: r.historyId, backfill_done_at: mb.backfill_done_at ?? now(), last_sync_at: now(), last_ok_at: now(), last_error: null, error_count: 0,
        });
        out.synced.push({ email: mb.email, ...r });
      } catch (e) {
        const revoked = e instanceof GmailAuthError && e.revoked;
        const msg = e instanceof GmailAuthError ? friendly(e) : e instanceof Error ? e.message.slice(0, 300) : String(e);
        await dbTicketStore.releaseMailbox(mb.email, token, revoked
          ? { state: "reconnect", last_sync_at: now(), last_error: msg }
          : { last_sync_at: now(), last_error: msg, error_count: (mb.error_count ?? 0) + 1 }).catch(() => {});
        if (revoked) {
          forgetAccessToken(mb.email);
          await osTable("os_notifications").upsert({
            kind: "tickets_reconnect", severity: "warning",
            title: `Tickets: reconnect ${mb.email}`,
            body: `${msg} Until then, client email to ${mb.email} won't appear in Tickets.`,
            ref: `tickets-reconnect:${mb.email}:${now().slice(0, 10)}`,
          }, { onConflict: "ref", ignoreDuplicates: true }).then(() => {}, () => {});
        }
        out.synced.push({ email: mb.email, error: msg });
      }
    }
  }

  try {
    for (const t of await dbTicketStore.snoozeDue(new Date().toISOString())) {
      const c = wake(t);
      if (!c) continue;
      await dbTicketStore.updateTicket(t.id, c.patch);
      await dbTicketStore.addEvents(t.id, c.events);
      out.woke++;
    }
  } catch { /* the table may not exist yet */ }
  return out;
}
