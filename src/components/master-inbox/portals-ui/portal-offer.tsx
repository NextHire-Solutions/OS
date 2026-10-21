"use client";

/*
 * Their offer (22 Oct): what the client told us in the new portal's Setup
 * wizard — what they give agents who join, why agents join them, and anything
 * we should never say. The team writes the client's recruiting emails from
 * it. Read-only here; the client fills it in on their portal.
 */

import { useState } from "react";
import { Megaphone } from "lucide-react";

import { ModalDialog } from "@/components/ui/modal-dialog";

type Offer = { offers: string[]; whyJoin: string; neverSay: string | null; updatedBy: string | null; updatedAt: string | null };

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }) : null);

export function PortalOffer({ portalId, portalName }: { portalId: string; portalName: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ offer: Offer | null; note?: string; error?: string } | null>(null);

  const show = async () => {
    setOpen(true);
    setState(null);
    try {
      const res = await fetch(`/api/tools/master-inbox/portals/offer?portal=${encodeURIComponent(portalId)}`);
      const j = (await res.json().catch(() => ({}))) as { offer?: Offer | null; note?: string; error?: string };
      setState(res.ok ? { offer: j.offer ?? null, note: j.note } : { offer: null, error: j.error ?? "The offer could not be read just now." });
    } catch {
      setState({ offer: null, error: "Couldn't reach the server. Please try again." });
    }
  };

  const o = state?.offer ?? null;
  return (
    <>
      <button type="button" className="open-live" onClick={() => void show()} data-portal-offer>
        Their offer
        <Megaphone />
      </button>
      <ModalDialog open={open} onClose={() => setOpen(false)} width={560} label={`Their offer — ${portalName}`}>
        <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 650 }}>Their offer — {portalName}</div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4, lineHeight: 1.6 }}>
              What {portalName} told us in their portal&apos;s setup. We write their recruiting emails from this.
            </div>
          </div>
          {!state ? (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>Loading…</div>
          ) : state.error ? (
            <div className="anno" style={{ background: "var(--red-bg)", borderColor: "var(--red-border)", color: "var(--red)" }}>{state.error}</div>
          ) : !o ? (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>{state.note ?? "Not filled in yet — the client gives it in the last step of their portal's setup."}</div>
          ) : (
            <dl style={{ margin: 0, display: "grid", gap: 14, fontSize: 13.5, lineHeight: 1.55 }}>
              <div>
                <dt style={{ fontWeight: 600, marginBottom: 4 }}>What they give agents who join</dt>
                <dd style={{ margin: 0 }}>{o.offers.length ? o.offers.join(" · ") : "—"}</dd>
              </div>
              <div>
                <dt style={{ fontWeight: 600, marginBottom: 4 }}>Why agents join them</dt>
                <dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>{o.whyJoin}</dd>
              </div>
              <div>
                <dt style={{ fontWeight: 600, marginBottom: 4 }}>Never say</dt>
                <dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>{o.neverSay || "Nothing given."}</dd>
              </div>
              {o.updatedAt ? <div style={{ fontSize: 12, color: "var(--muted)" }}>Saved {day(o.updatedAt)}{o.updatedBy ? ` by ${o.updatedBy}` : ""}.</div> : null}
            </dl>
          )}
        </div>
      </ModalDialog>
    </>
  );
}
