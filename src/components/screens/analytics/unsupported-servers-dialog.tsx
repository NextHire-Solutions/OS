"use client";

import { useEffect, useState } from "react";

import { fullNumber } from "@/lib/tools/analytics/format.ts";

import { DialogFrame, Fail, Warn } from "./dialog-frame";
import { Btn, ConfirmButton } from "./toast";

/*
 * Remove Unsupported Mail Servers (1 Oct). Opens with a count per server,
 * read from the platform at that moment; removing asks for a second click,
 * finds the leads again on the server and counts again afterwards.
 */

interface Found { total: number; byServer: { server: string; count: number }[]; missing: string[] }
interface Removal extends Found { ok: boolean; removed: number; remaining: number; error?: string }

export function UnsupportedServersDialog({ campaignId, campaignName, platform, open, onOpenChange, onDone }: {
  campaignId: string;
  campaignName: string;
  platform: "emailbison" | "instantly";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Removal | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setFound(null); setError(null); setResult(null);
    fetch(`/api/tools/analytics/campaigns/${encodeURIComponent(campaignId)}/unsupported-servers`, { cache: "no-store" })
      .then(async (r) => { const b = await r.json().catch(() => null); if (!r.ok) throw new Error(b?.error ?? `HTTP ${r.status}`); return b as Found; })
      .then((b) => { if (live) setFound(b); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [open, campaignId]);

  async function remove() {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/tools/analytics/campaigns/${encodeURIComponent(campaignId)}/unsupported-servers`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok && r.status !== 207) throw new Error(b?.error ?? `HTTP ${r.status}`);
      setResult(b as Removal);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const close = () => { if (!busy) onOpenChange(false); };
  return (
    <DialogFrame
      open={open}
      onClose={close}
      title="Remove unsupported mail servers"
      description={<>Leads on {campaignName} whose mail server is Proofpoint, Mimecast, Barracuda, Zoho or a custom server.</>}
      footer={
        result ? <Btn onClick={close}>Done</Btn> : (
          <>
            <Btn onClick={close} disabled={busy}>Cancel</Btn>
            <ConfirmButton primary label={busy ? "Removing…" : `Remove ${found ? fullNumber(found.total) : ""} leads`}
              armedLabel={`Remove ${found ? fullNumber(found.total) : ""} leads from this campaign?`}
              title="Removes them from this campaign; the leads themselves are kept."
              disabled={busy || !found || found.total === 0} onConfirm={() => void remove()} />
          </>
        )
      }
    >
      {!found && !error ? <p className="mut" style={{ margin: 0 }}>Counting the campaign&apos;s leads by mail server…</p> : null}
      {found && !result ? (
        <div style={{ display: "grid", gap: 10 }}>
          <table className="tbl" style={{ width: "100%" }}>
            <tbody>
              {found.byServer.map((s) => (
                <tr key={s.server}><td>{s.server}</td><td className="tnum" style={{ textAlign: "right" }}>{fullNumber(s.count)}</td></tr>
              ))}
              <tr><td><b>Total to remove</b></td><td className="tnum" style={{ textAlign: "right" }}><b>{fullNumber(found.total)}</b></td></tr>
            </tbody>
          </table>
          {platform === "instantly" ? (
            <Warn>Instantly reports Proofpoint, Mimecast, Barracuda and custom servers all as “other”, so they are removed together.</Warn>
          ) : null}
          {found.missing.length ? <Warn>Not found in EmailBison as a tag: {found.missing.join(", ")}.</Warn> : null}
          <Warn>They are removed from this campaign only — the leads themselves are kept. This cannot be undone from here.</Warn>
        </div>
      ) : null}
      {result ? (
        <div style={{ display: "grid", gap: 8 }}>
          <p style={{ margin: 0 }} className="tnum">Removed <b>{fullNumber(result.removed)}</b> lead{result.removed === 1 ? "" : "s"}.{result.remaining ? ` ${fullNumber(result.remaining)} are still on the campaign.` : " None are left."}</p>
          {result.error ? <Fail>{result.error}</Fail> : null}
        </div>
      ) : null}
      {error ? <Fail>{error}</Fail> : null}
    </DialogFrame>
  );
}
