"use client";

import { PageHeader } from "@/components/ds";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { ModalDialog } from "@/components/ui/modal-dialog";
import type { MailboxesPage, MailboxView } from "@/lib/tools/tickets/types";
import { canSendFrom } from "@/lib/tools/tickets/senders";

import { ago, api, Avatar, Icon, useNow } from "./ui";
import { TICKETS_OTHERS_ON } from "@/lib/tools/tickets/others-switch";

/*
 * TICKETS › Connected inboxes — each teammate connects their own Gmail (read-only). Says plainly what the OS reads
 * and what it keeps (only emails from client addresses: the user's rule, 20 Nov), who has connected, and the state
 * of each connection. Anyone can disconnect their own inbox; admins can disconnect any.
 */

const STATE: Record<MailboxView["state"], { label: string; cls: string }> = {
  syncing: { label: "Fetching the last 30 days", cls: "syncing" },
  ok: { label: "Up to date", cls: "ok" },
  reconnect: { label: "Needs reconnecting", cls: "reconnect" },
  paused: { label: "Disconnected", cls: "paused" },
};

export function TicketsInboxesScreen() {
  const [d, setD] = useState<MailboxesPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<MailboxView | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow();

  const load = useCallback(async () => {
    try { setD(await api<MailboxesPage>("/api/tools/tickets/inboxes")); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't load the inboxes"); }
  }, []);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("connected")) setNotice({ kind: "ok", text: `${p.get("connected")} is connected. Client email from the last 30 days is being fetched now; it shows in Tickets within a few minutes.${TICKETS_OTHERS_ON ? " Other email goes to Others from now on." : ""}` });
    else if (p.get("error")) setNotice({ kind: "err", text: p.get("error")! });
    if (p.get("connected") || p.get("error")) window.history.replaceState(window.history.state, "", window.location.pathname);
    void load();
  }, [load]);

  // While a first fetch runs, check back every 10 seconds.
  const syncing = d?.mailboxes.some((m) => m.state === "syncing");
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, syncing ? 10_000 : 60_000);
    return () => clearInterval(t);
  }, [load, syncing]);

  const mine = d?.mailboxes.find((m) => m.email === d.me) ?? d?.mailboxes.find((m) => m.mine && m.state !== "paused") ?? null;
  const connectedTeam = d?.team.filter((p) => p.connected).length ?? 0;

  const syncNow = async () => {
    try { await api("/api/tools/tickets/inboxes", { method: "POST", json: { sync: true } }); toast.success("Checking for new client email now"); setTimeout(() => void load(), 4000); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't start"); }
  };

  return (
    <div className="tk-shell">
      <div className="tk-page">
        {/* The OS's own page header, as Performance and Consistency (the sidebar is the way back to the tickets). */}
        <PageHeader
          kicker="Tickets"
          title="Connected inboxes"
          description={TICKETS_OTHERS_ON
            ? "Tickets reads the Gmail of each teammate who connects. Email from a client's address becomes a client ticket; every other email goes to Others. Connect yours so client email sent to you reaches the whole team."
            : "Tickets reads the Gmail of each teammate who connects, and shares only the email that comes from a client's address. Connect yours so client email sent to you reaches the whole team."}
        />

        {notice ? (
          <div className={`tk-notice ${notice.kind}`} role="status">
            <Icon name={notice.kind === "ok" ? "checkc" : "ban"} /><span>{notice.text}</span>
          </div>
        ) : null}
        {err ? <div className="tk-notice err" role="alert"><Icon name="ban" /><span>{err}</span></div> : null}
        {d && !d.ready ? <div className="tk-notice warn"><Icon name="flag" /><span>{d.admin ? d.setup : "An admin needs to finish one setup step before inboxes can be connected."}</span></div> : null}
        {/* Only while a setting is actually missing (20 Nov, the user: the setup is done, so the note had no reason to show). */}
        {d && d.admin && d.ready && d.missing.length > 0 ? (
          <div className="tk-notice warn">
            <Icon name="shield" />
            <span>
              <b>One-time Google setup (admins):</b> Tickets needs its own Google sign-in client: an OAuth client of type Web application in the BrokerStaffer Google Cloud, consent screen Internal, with this authorised redirect URI: <code>{d.callback}</code>
              {d.missing.length ? <> Still to set on the OS: {d.missing.map((m, i) => <span key={m}>{i ? ", " : ""}<code>{m}</code></span>)}.</> : null}
            </span>
          </div>
        ) : null}

        <div className="tk-grid2">
          <div style={{ display: "grid", gap: 18 }}>
            <section className="tk-card" aria-labelledby="tk-mine-h">
              <h2 id="tk-mine-h">Your inbox</h2>
              {!d ? <div className="tk-skel" style={{ border: 0, padding: 0 }}><i style={{ width: "60%" }} /><i style={{ width: "40%" }} /></div>
                : mine && mine.state !== "paused" ? (
                  <div className="tk-me">
                    <div className="tk-me-ico"><Icon name="mail" /></div>
                    <div className="tk-me-t">
                      <b>{mine.email}</b>
                      <span><span className={`tk-state ${STATE[mine.state].cls}`}><i />{STATE[mine.state].label}</span> · {mine.tickets} {mine.tickets === 1 ? "ticket" : "tickets"} from {mine.emails} {mine.emails === 1 ? "email" : "emails"}{mine.lastOkAt ? ` · checked ${ago(mine.lastOkAt, now)}` : ""}</span>
                      {mine.lastError ? <span style={{ color: "var(--ds-red)" }}>{mine.lastError}</span> : null}
                      {mine.sends === "on" ? <span data-sends="on">Replies written in Tickets go from this inbox.</span> : null}
                      {mine.sends === "reconnect" && mine.state !== "reconnect" ? <span data-sends="reconnect" style={{ color: "var(--ds-amber, #b45309)" }}>Reconnect once so the team&apos;s replies in Tickets can go from this inbox.</span> : null}
                    </div>
                    {mine.sends === "reconnect" && mine.state !== "reconnect" ? <a className="tk-btn pri" href="/api/tools/tickets/google/start"><Icon name="reply" />Allow replies</a> : null}
                    {mine.state === "reconnect"
                      ? <a className="tk-btn pri" href="/api/tools/tickets/google/start"><Icon name="refresh" />Reconnect</a>
                      : <button type="button" className="tk-btn" onClick={() => void syncNow()}><Icon name="refresh" />Check now</button>}
                    <button type="button" className="tk-btn ghost danger" onClick={() => setConfirm(mine)}>Disconnect</button>
                  </div>
                ) : (
                  <div className="tk-me">
                    <div className="tk-me-ico"><Icon name="mail" /></div>
                    <div className="tk-me-t">
                      <b>Not connected</b>
                      <span>{canSendFrom(d.me) ? "Google will ask you to let Tickets read your Gmail and send the replies the team writes in Tickets." : "Google will ask you to allow read-only access to your Gmail."}</span>
                    </div>
                    <a className={`tk-btn pri${d.ready && d.googleConfigured ? "" : " disabled"}`} href={d.ready && d.googleConfigured ? "/api/tools/tickets/google/start" : undefined} aria-disabled={!(d.ready && d.googleConfigured)}
                      title={d.googleConfigured ? undefined : "Google sign-in for Tickets isn't set up yet"}><Icon name="plus" />Connect your Gmail</a>
                  </div>
                )}
            </section>

            <section className="tk-card" aria-labelledby="tk-all-h">
              <h2 id="tk-all-h">All connected inboxes</h2>
              {d && d.mailboxes.length ? (
                <div className="tk-table-wrap">
                  <table className="tk-table">
                    <thead><tr><th>Inbox</th><th>State</th><th title="Distinct tickets this inbox received (not those marked Not a ticket)">Tickets</th><th title="Emails stored from this inbox: client emails and your team's replies">Emails</th><th>Checked</th><th aria-label="Actions" /></tr></thead>
                    <tbody>
                      {d.mailboxes.map((m) => (
                        <tr key={m.email}>
                          <td><div className="tk-ibx"><Avatar email={m.email} name={m.name} /><div><div className="tk-ibx-n">{m.name ?? m.email}</div>{m.name && m.name !== m.email ? <div className="tk-ibx-e">{m.email}</div> : null}</div></div>{m.lastError && m.state !== "paused" ? <span className="err">{m.lastError}</span> : null}</td>
                          <td>
                            <div className="tk-states" data-sends-cell={m.email} data-sends={m.sends ?? "none"}>
                              <span className={`tk-state ${STATE[m.state].cls}`}><i />{STATE[m.state].label}</span>
                              {/* Replies from Tickets go only from Amy's and Eddy's inboxes (senders.ts). */}
                              {m.sends === "on" ? <span className="tk-state ok" title="Replies written in Tickets go from this inbox"><Icon name="reply" />Sends replies</span> : null}
                              {m.sends === "reconnect" ? <span className="tk-state warn" title={`${m.name ?? m.email} reconnects once to allow replies from Tickets`}><Icon name="reply" />Replies: reconnect</span> : null}
                            </div>
                          </td>
                          <td className="n">{m.tickets}</td>
                          <td className="n">{m.emails}</td>
                          <td className="n" title={m.lastOkAt ?? ""}>{m.lastOkAt ? ago(m.lastOkAt, now) : "–"}</td>
                          <td style={{ textAlign: "right" }}>{(d.admin || m.mine) && m.state !== "paused" ? <button type="button" className="tk-btn ghost danger icon tk-disc" onClick={() => setConfirm(m)} title={`Disconnect ${m.email}`} aria-label={`Disconnect ${m.email}`}><Icon name="x" /></button> : null}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p>No inbox is connected yet. The first one starts Tickets.</p>}
            </section>
          </div>

          <div style={{ display: "grid", gap: 18 }}>
            <section className="tk-card" aria-labelledby="tk-priv-h">
              <h2 id="tk-priv-h">What Tickets reads, and what it keeps</h2>
              <div className="tk-privacy">
                <div><Icon name="check" /><span><b>Kept and shared:</b> emails sent <b>from a client&apos;s address</b>, meaning an address on the client&apos;s record or its portal lists. The whole team with Tickets access can see them.</span></div>
                {TICKETS_OTHERS_ON ? <div><Icon name="mail" /><span><b>Others:</b> from the moment an inbox is connected, every other email that reaches it (other senders, someone new at a client&apos;s company, notifications, newsletters and personal email) is kept in <b>Others</b>, and the whole team with Tickets access can see it.</span></div> : null}
                <div><Icon name="check" /><span><b>Noted, never shown:</b> when you reply to a client in Gmail, Tickets records only that you replied and when, so the ticket moves to Waiting. Your reply&apos;s text is never stored.</span></div>
                <div><Icon name="reply" /><span><b>Replies written in Tickets:</b> sent from Amy&apos;s or Eddy&apos;s inbox, whichever the client wrote to, in the same conversation. The reply and who sent it are kept on the ticket.</span></div>
                {TICKETS_OTHERS_ON
                  ? <div className="no"><Icon name="x" /><span><b>Never kept:</b> spam, drafts, chats, calendar invitations, and email only between teammates.</span></div>
                  : <div className="no"><Icon name="x" /><span><b>Never kept:</b> everything else. That includes personal email, other senders, people the client copies in, and someone new at a client&apos;s company until they&apos;re added to the client&apos;s record.</span></div>}
                <div className="no"><Icon name="x" /><span><b>Never done:</b> deleting, labelling or marking anything read in your Gmail. Nothing is ever sent except a reply a teammate writes and sends in Tickets, and only from Amy&apos;s or Eddy&apos;s inbox.</span></div>
                <div><Icon name="check" /><span>Disconnect any time. Google forgets the OS&apos;s access, and tickets already shared stay.</span></div>
              </div>
            </section>

            <section className="tk-card" aria-labelledby="tk-team-h">
              <h2 id="tk-team-h">Team coverage</h2>
              <p>{connectedTeam} of {d?.team.length ?? "–"} teammates connected. Client email sent only to someone not connected won&apos;t appear in Tickets.</p>
              <div className="tk-cov-bar"><span style={{ width: `${d?.team.length ? (100 * connectedTeam) / d.team.length : 0}%` }} /></div>
              <div className="tk-team">
                {(d?.team ?? []).map((p) => (
                  <div key={p.email}>
                    <Avatar email={p.email} name={p.name} />
                    <span>{p.name}</span><span className="e">{p.email}</span>
                    <span className="tk-sp" />
                    {p.connected ? <span className="tk-state ok"><i />Connected</span> : <span className="tk-state paused"><i />Not yet</span>}
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>

      <ModalDialog open={!!confirm} onClose={() => setConfirm(null)} width={460} label="Disconnect inbox">
        <div className="tk-dialog">
          <h3>Disconnect {confirm?.email}?</h3>
          <p>Google is told to drop the OS&apos;s access and the stored access is erased. New client email to this inbox stops appearing in Tickets. Tickets already shared stay.</p>
          <div className="tk-dialog-f">
            <button type="button" className="tk-btn" onClick={() => setConfirm(null)}>Keep it connected</button>
            <button type="button" className="tk-btn danger solid" disabled={busy} onClick={async () => {
              if (!confirm) return;
              setBusy(true);
              try {
                await api(`/api/tools/tickets/inboxes?email=${encodeURIComponent(confirm.email)}`, { method: "DELETE" });
                toast.success(`${confirm.email} disconnected`);
                setConfirm(null);
                await load();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Couldn't disconnect");
              } finally {
                setBusy(false);
              }
            }}>Disconnect</button>
          </div>
        </div>
      </ModalDialog>
    </div>
  );
}
