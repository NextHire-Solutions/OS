"use client";

import { Fragment, useCallback, useEffect, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import type { RelayEmailView } from "@/lib/tools/master-inbox/relay/relay";
import { stamp } from "@/lib/tools/master-inbox/relay/wording";

/*
 * One hand-off's email, in full (23 Oct, the user: "we cannot get enough
 * information from here like what the email will look, what will be the
 * subject. we need full transparency so that we can check each and everything
 * in practice mode"). From, To, Reply-To and subject as Postmark would be
 * given them; the message as the brokerage's mail program would show it; the
 * plain-text version; the extra headers and Postmark's settings. Read from the
 * stored record (/api/tools/master-inbox/relay/email) — the very email a send
 * would use. Opening it sends nothing.
 */

/* The HTML in a frame that can run nothing and load nothing from outside: no scripts, its own origin, no network. */
function framed(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{margin:0;padding:16px 18px;font:14px/1.5 Arial,Helvetica,sans-serif;color:#222;background:#fff;word-wrap:break-word}</style></head><body>${html}</body></html>`;
}

const STATUS: Record<string, string> = {
  practice: "Practice — nothing was sent. This is exactly the email that would have gone to the brokerage if the hand-off were live.",
  ready: "Prepared and waiting for “Send to brokerage” — nothing has been sent.",
  held: "Held — nothing was sent.",
  skipped: "Skipped — nothing was sent.",
  sending: "Being sent.",
  sent: "Sent to the brokerage.",
  failed: "Postmark refused it — nothing was sent.",
  bounced: "Sent, then bounced.",
};

export function RelayEmailButton({ relayId }: { relayId: string }) {
  const [open, setOpen] = useState(false);
  // Stable: ModalDialog re-runs its focus handling whenever onClose changes.
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" className="btn" style={{ whiteSpace: "nowrap" }} onClick={() => setOpen(true)}>View email</button>
      {open ? <RelayEmailDialog relayId={relayId} onClose={close} /> : null}
    </>
  );
}

function RelayEmailDialog({ relayId, onClose }: { relayId: string; onClose: () => void }) {
  const [state, setState] = useState<{ view?: RelayEmailView; error?: string } | null>(null);
  const [tab, setTab] = useState<"look" | "text" | "tech">("look");

  useEffect(() => {
    let live = true;
    fetch(`/api/tools/master-inbox/relay/email?id=${encodeURIComponent(relayId)}`, { cache: "no-store" })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as (RelayEmailView & { error?: string }) | null;
        if (!live) return;
        setState(r.ok && body?.record ? { view: body } : { error: body?.error ?? `Could not read the hand-off (HTTP ${r.status}).` });
      })
      .catch(() => live && setState({ error: "The OS could not be reached." }));
    return () => { live = false; };
  }, [relayId]);

  const v = state?.view;
  const e = v?.email;
  return (
    <ModalDialog open onClose={onClose} width={860} label="Hand-off email">
      <div className="mis-em" data-testid="relay-email">
        <header className="mis-em-head">
          <div>
            <h2>Hand-off email</h2>
            {v ? (
              <p>
                {v.record.agentName ?? "Agent"} → {v.record.brokerageName ?? v.record.campaignName ?? "brokerage"}
                {v.record.createdAt ? ` · prepared ${stamp(v.record.createdAt, "1970-01-01")}` : ""}
              </p>
            ) : null}
          </div>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </header>

        {!state ? <p className="mis-em-pad mut" role="status">Reading the hand-off…</p> : null}
        {state?.error ? <p className="mis-em-pad mis-em-err" role="alert">{state.error}</p> : null}

        {v ? (
          <div className="mis-em-body">
            <div className={`mis-em-state ${v.record.status === "sent" || v.record.status === "bounced" ? "is-sent" : "is-safe"}`} data-testid="relay-email-state">
              <b>{v.record.practice && v.record.status !== "sent" && v.record.status !== "bounced" && v.record.status !== "sending" ? `${STATUS.practice}${v.record.status === "ready" ? " Pressing “Send to brokerage” on it would only record practice." : ""}` : STATUS[v.record.status] ?? v.record.status}</b>
              {v.record.status !== "sent" && v.record.status !== "bounced" ? (
                <span>
                  {v.server.liveSendAllowed
                    ? "This server is allowed to send for real only when the hand-off is on, practice is off and the brokerage is switched on."
                    : "This server cannot send hand-offs at all: its live-send switch is off."}
                </span>
              ) : v.providerMessageId ? <span>Postmark message {v.providerMessageId}{v.record.sentAt ? ` · ${stamp(v.record.sentAt, "1970-01-01")}` : ""}</span> : null}
            </div>

            {!e ? (
              <p className="mut">No email was prepared for this one — it stopped before an email was built. {v.record.detail ?? ""}</p>
            ) : (
              <>
                <dl className="mis-em-hdr" data-testid="relay-email-headers">
                  <dt>From</dt><dd>{e.from}</dd>
                  <dt>To</dt><dd>{e.to.map((t) => <div key={t.email}>{t.header}</div>)}</dd>
                  <dt>Cc / Bcc</dt><dd className="mut">none</dd>
                  <dt>Reply-To</dt><dd>{e.replyTo ?? "—"} <span className="mut">— a reply from the brokerage goes straight to the agent</span></dd>
                  <dt>Subject</dt><dd className="mis-em-subj">{e.subject}</dd>
                </dl>

                <div className="mis-em-tabs" role="tablist" aria-label="View">
                  {([["look", "As the brokerage sees it"], ["text", "Plain-text version"], ["tech", "Headers and Postmark"]] as const).map(([k, label]) => (
                    <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : undefined} onClick={() => setTab(k)}>{label}</button>
                  ))}
                </div>

                {tab === "look" ? (
                  <iframe className="mis-em-frame" title="The email as the brokerage sees it" sandbox="" referrerPolicy="no-referrer" srcDoc={framed(e.htmlBody)} data-testid="relay-email-frame" />
                ) : tab === "text" ? (
                  <pre className="mis-em-text" data-testid="relay-email-text">{e.textBody}</pre>
                ) : (
                  <dl className="mis-em-hdr mis-em-tech">
                    {e.headers.map((h) => <Fragment key={h.Name}><dt>{h.Name}</dt><dd className="mono">{h.Value}</dd></Fragment>)}
                    <dt>Postmark stream</dt><dd className="mono">{v.postmark.stream}</dd>
                    <dt>Open tracking</dt><dd>Off</dd>
                    <dt>Link tracking</dt><dd>Off — links reach the brokerage untouched</dd>
                    <dt>Tag</dt><dd className="mono">{v.postmark.tag}</dd>
                    <dt>Hand-off id</dt><dd className="mono">{v.record.id}</dd>
                    {v.record.agentEmail ? <><dt>Agent</dt><dd>{v.record.agentEmail}</dd></> : null}
                  </dl>
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
    </ModalDialog>
  );
}
