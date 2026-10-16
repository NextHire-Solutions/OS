"use client";

import { useCallback, useEffect, useState } from "react";

import type { LineTone, RelayRecordView } from "@/lib/tools/master-inbox/relay/wording";

/*
 * The brokerage hand-off, on the conversation (plan §3.5: "Every send is
 * recorded on the conversation — 'Sent to Angela at 10:42' — so the team can
 * always see what reached whom").
 *
 * Renders nothing when this conversation has no hand-off (or the relay's
 * tables do not exist yet), so every other conversation looks exactly as it
 * did. Loading it is a GET that reads only; the one button — "Send to
 * brokerage" in one-click mode, "Try again", "Check again" — is a POST that
 * re-runs every check on the server, and in practice mode records what would
 * have gone without sending anything.
 */

type Rec = RelayRecordView & { line: { tone: LineTone; text: string } };

function actionFor(r: Rec): string | null {
  if (r.status === "ready") return r.practice ? "Send to brokerage (practice)" : "Send to brokerage";
  if (r.status === "held") return "Check again";
  if (r.status === "failed" && r.reason === "send_failed") return "Try again";
  return null;
}

export function BrokerageRelayStrip({ threadId }: { threadId: string }) {
  const [records, setRecords] = useState<Rec[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Prepared again — press again": the press did not do what its label said, because the mode changed.
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/relay`, { cache: "no-store" });
      if (!res.ok) return setRecords([]);
      const body = (await res.json()) as { available?: boolean; records?: Rec[] };
      setRecords(body.available ? body.records ?? [] : []);
    } catch {
      setRecords([]);
    }
  }, [threadId]);

  useEffect(() => {
    setRecords(null);
    setError(null);
    setNotice(null);
    void load();
  }, [load]);

  const press = async (r: Rec) => {
    setBusy(r.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/tools/master-inbox/threads/${threadId}/relay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relayId: r.id }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; notice?: string | null } | null;
      if (!res.ok) setError(body?.error ?? `The hand-off failed (${res.status})`);
      else if (body?.notice) setNotice(body.notice);
      await load();
    } catch {
      setError("The server could not be reached. Check the line above before pressing again.");
    } finally {
      setBusy(null);
    }
  };

  if (!records || records.length === 0) return null;

  return (
    <div className="mi-relay" aria-label="Brokerage hand-off">
      {records.map((r) => {
        const action = actionFor(r);
        const to = r.recipients.map((x) => (x.name ? `${x.name} <${x.email}>` : x.email)).join(", ");
        return (
          <div key={r.id} className={`mi-relay-row mi-relay-${r.line.tone}`}>
            <span className="mi-relay-text" title={to ? `To: ${to}${r.subject ? `\nSubject: ${r.subject}` : ""}` : undefined}>
              {r.line.text}
            </span>
            {action ? (
              <button type="button" className="mi-relay-btn" disabled={busy !== null} onClick={() => press(r)}>
                {busy === r.id ? "Working…" : action}
              </button>
            ) : null}
          </div>
        );
      })}
      {notice ? (
        <div className="mi-relay-row mi-relay-waiting" role="status">
          <span className="mi-relay-text">{notice}</span>
        </div>
      ) : null}
      {error ? (
        <div className="mi-relay-row mi-relay-problem" role="alert">
          <span className="mi-relay-text">{error}</span>
        </div>
      ) : null}
    </div>
  );
}
